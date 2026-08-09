"""読み取り応答のキャッシュと ETag による再検証。

参照が大半で更新が少ない使われ方のため、直列化済みの応答をそのまま保持する。
ORM のオブジェクト生成と Pydantic の検証が1リクエストの8割を占めており、
ここを丸ごと省ける。

書き込みがあると app_settings の data_version を進め、各ワーカーが
それを検知して保持中の応答を捨てる。TTL による遅延ではないので、
編集は次の取得から反映される（バージョン確認は最大1秒間だけ再利用する）。
"""

import hashlib
import time
from collections import OrderedDict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

VERSION_KEY = "data_version"
VERSION_TTL = 1.0          # バージョン問い合わせを再利用する秒数
MAX_ENTRIES = 256          # 保持する応答の数（超えたら古いものから捨てる）

# キャッシュ対象外。ファイル生成や配布物のダウンロードは都度実行する
SKIP_PREFIXES = ("/api/export/", "/api/backup/")

# 引き継がないヘッダ。本文から再計算されるものと、応答ごとに変わるもの
DROP_HEADERS = {"content-length", "set-cookie", "date", "server"}
# 304 では本文を返さないため、本文に紐づくヘッダも落とす
DROP_ON_304 = DROP_HEADERS | {"content-type", "content-encoding"}

_cache: "OrderedDict[tuple, tuple[str, bytes, str, dict]]" = OrderedDict()
_cached_version: int = -1
_version_checked_at: float = 0.0


def _read_version() -> int:
    from .database import SessionLocal
    from .models import AppSetting
    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == VERSION_KEY).first()
        return int(row.value) if row and row.value and row.value.isdigit() else 0
    except Exception:
        return 0
    finally:
        db.close()


def current_version() -> int:
    """データ版数。最大 VERSION_TTL 秒は問い合わせ結果を再利用する"""
    global _cached_version, _version_checked_at
    now = time.monotonic()
    if _cached_version >= 0 and now - _version_checked_at < VERSION_TTL:
        return _cached_version
    v = _read_version()
    if v != _cached_version:
        _cache.clear()
    _cached_version = v
    _version_checked_at = now
    return v


def bump_version():
    """書き込み後に呼ぶ。全ワーカーの保持内容が次の確認で無効になる"""
    global _cached_version, _version_checked_at
    from .database import SessionLocal
    from .models import AppSetting
    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == VERSION_KEY).first()
        if row:
            row.value = str((int(row.value) if row.value and row.value.isdigit() else 0) + 1)
        else:
            db.add(AppSetting(key=VERSION_KEY, value="1"))
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()
    _cache.clear()
    _cached_version = -1
    _version_checked_at = 0.0


def _cacheable(path: str) -> bool:
    return path.startswith("/api/") and not path.startswith(SKIP_PREFIXES)


def _respond(request: Request, etag: str, body: bytes, headers: dict) -> Response:
    """ETag が一致すれば 304、そうでなければ本文を返す"""
    common = {**headers, "ETag": etag, "Cache-Control": "private, no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={
            k: v for k, v in common.items() if k.lower() not in DROP_ON_304})
    return Response(content=body, status_code=200, headers=common)


class ResponseCacheMiddleware(BaseHTTPMiddleware):
    """GET の応答を版数つきで保持し、ETag が一致すれば 304 を返す"""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        method = request.method

        if method not in ("GET", "HEAD"):
            response = await call_next(request)
            # ログイン・ログアウトはデータを変えないので版数を進めない
            if response.status_code < 400 and path not in ("/auth/verify", "/auth/logout"):
                bump_version()
            return response

        if not _cacheable(path):
            return await call_next(request)

        version = current_version()
        # 応答が変わる要因はすべて鍵に含める。
        # Origin は CORS ヘッダ（Access-Control-Allow-Origin）が変わるため必要
        accepts_gzip = "gzip" in request.headers.get("accept-encoding", "")
        role = getattr(request.state, "role", "admin")
        origin = request.headers.get("origin", "")
        key = (path, request.url.query, role, accepts_gzip, origin)

        hit = _cache.get(key)
        if hit is not None:
            etag, body, headers = hit
            _cache.move_to_end(key)
            return _respond(request, etag, body, headers)

        response = await call_next(request)
        if response.status_code != 200:
            return response

        body = b"".join([chunk async for chunk in response.body_iterator])
        etag = 'W/"%s-%d"' % (hashlib.sha256(body).hexdigest()[:24], version)
        # 内側のミドルウェアが付けたヘッダ（セキュリティヘッダ・CORS・Vary など）を
        # そのまま引き継ぐ。ここで取りこぼすと、キャッシュ対象の応答だけ欠落する
        headers = {k: v for k, v in response.headers.items()
                   if k.lower() not in DROP_HEADERS}

        _cache[key] = (etag, body, headers)
        _cache.move_to_end(key)
        while len(_cache) > MAX_ENTRIES:
            _cache.popitem(last=False)

        return _respond(request, etag, body, headers)
