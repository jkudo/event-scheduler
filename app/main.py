import json
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import UPLOAD_DIR
from .database import Base, engine, SessionLocal
from .models import (
    Room, Session as SessionModel, LTTalk, Staff, StaffSkill,
    StaffPreferredSession, StaffAvailability, VenueMap, Assignment, Category, SessionGroup,
    AppSetting,
)
from .routers import rooms, sessions, staffs, assignments, venue_maps, export, backup, auth, settings, categories, session_groups, auto_backup, public_api, import_data

from sqlalchemy import inspect as sa_inspect, text as sa_text
from sqlalchemy.exc import OperationalError

from .config import IS_SQLITE
from .worker import become_leader, exclusive, run_once, worker_count


def _wait_for_db(timeout: int = 90):
    """DB コンテナを併走させる構成では、DB が待ち受けを始める前にアプリが起動し得る"""
    if IS_SQLITE:
        return
    deadline = time.monotonic() + timeout
    while True:
        try:
            with engine.connect() as conn:
                conn.execute(sa_text("SELECT 1"))
            return
        except OperationalError:
            if time.monotonic() >= deadline:
                raise
            print("[startup] DB の待ち受けを待機中")
            time.sleep(2)


_wait_for_db()
# 複数ワーカーだとテーブル作成が同時に走って衝突するため、1プロセスずつ通す
with exclusive("migrate"):
    Base.metadata.create_all(bind=engine)

# --- Auto-migration: add missing columns to existing tables ---

def _auto_migrate():
    """Add columns that exist in models but not in the DB (simple ALTER TABLE ADD COLUMN)."""
    with engine.connect() as conn:
        # inspect() を使うと SQLite / PostgreSQL のどちらでも同じコードで調べられる
        inspector = sa_inspect(conn)
        table_names = set(inspector.get_table_names())
        for table in Base.metadata.sorted_tables:
            if table.name not in table_names:
                continue
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for col in table.columns:
                if col.name not in existing:
                    col_type = col.type.compile(engine.dialect)
                    stmt = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col_type}"
                    print(f"[migration] {stmt}")
                    conn.execute(sa_text(stmt))
                    conn.commit()
                    print(f"[migration] OK: added {table.name}.{col.name}")
                    # Set default value for new text columns (ALTER TABLE adds NULL)
                    if str(col_type).upper() in ("VARCHAR", "TEXT", "STRING"):
                        conn.execute(sa_text(
                            f"UPDATE {table.name} SET {col.name} = '' WHERE {col.name} IS NULL"
                        ))
                        conn.commit()

OVERALL_ROOM_NAME = "全体"


def _ensure_overall_room():
    """全体スケジュール用の削除不可の「全体」部屋を用意し、既存overallを紐付ける。"""
    if not _table_exists("rooms") or not _table_exists("sessions"):
        return
    with engine.connect() as conn:
        row = conn.execute(sa_text(
            "SELECT id FROM rooms WHERE name = :n LIMIT 1"
        ), {"n": OVERALL_ROOM_NAME}).fetchone()
        if row:
            room_id = row[0]
        else:
            # 部屋が1件も無い場合はまだ作らない（初期セットアップ前）
            has_any = conn.execute(sa_text("SELECT 1 FROM rooms LIMIT 1")).fetchone()
            has_overall = conn.execute(sa_text(
                "SELECT 1 FROM sessions WHERE category='overall' LIMIT 1"
            )).fetchone()
            if not has_any and not has_overall:
                return
            conn.execute(sa_text(
                "INSERT INTO rooms (name, capacity, floor) VALUES (:n, 0, 0)"
            ), {"n": OVERALL_ROOM_NAME})
            conn.commit()
            room_id = conn.execute(sa_text(
                "SELECT id FROM rooms WHERE name = :n LIMIT 1"
            ), {"n": OVERALL_ROOM_NAME}).fetchone()[0]
            print(f"[migration] created '{OVERALL_ROOM_NAME}' room (id={room_id})")
        # 既存の全体スケジュールを「全体」部屋に紐付け
        conn.execute(sa_text(
            "UPDATE sessions SET room_id = :rid WHERE category='overall' AND room_id != :rid"
        ), {"rid": room_id})
        conn.commit()


def _ensure_overall_all_staff():
    """既存の全体スケジュールを「全員」対象(-1)に揃える。

    全体スケジュールは個々人を配置するものではないため既定を全員とする。
    以降に「全員」を解除した設定を上書きしないよう、この移行は一度だけ実行する。
    """
    if not _table_exists("sessions") or not _table_exists("app_settings"):
        return
    with engine.connect() as conn:
        done = conn.execute(sa_text(
            "SELECT 1 FROM app_settings WHERE key='migrated_overall_all_staff'"
        )).fetchone()
        if done:
            return
        result = conn.execute(sa_text(
            "UPDATE sessions SET required_staff = -1 WHERE category='overall' AND required_staff = 0"
        ))
        conn.execute(sa_text(
            "INSERT INTO app_settings (key, value) VALUES ('migrated_overall_all_staff', '1')"
        ))
        conn.commit()
        if result.rowcount:
            print(f"[migration] set {result.rowcount} overall schedule(s) to all-staff")


def _normalize_preference_priorities():
    """スタッフごとの希望優先度が重複していれば 1..N に振り直す。

    重複禁止は新規入力にしか効かないため、既存データを一度だけ揃える。
    """
    if not _table_exists("staff_preferred_sessions") or not _table_exists("app_settings"):
        return
    with engine.connect() as conn:
        done = conn.execute(sa_text(
            "SELECT 1 FROM app_settings WHERE key='migrated_pref_priority'"
        )).fetchone()
        if done:
            return
        rows = conn.execute(sa_text(
            "SELECT id, staff_id FROM staff_preferred_sessions ORDER BY staff_id, priority, id"
        )).fetchall()
        fixed = 0
        current_staff, seq = None, 0
        for row_id, staff_id in rows:
            if staff_id != current_staff:
                current_staff, seq = staff_id, 0
            seq += 1
            result = conn.execute(sa_text(
                "UPDATE staff_preferred_sessions SET priority = :p WHERE id = :i AND priority != :p"
            ), {"p": seq, "i": row_id})
            fixed += result.rowcount
        conn.execute(sa_text(
            "INSERT INTO app_settings (key, value) VALUES ('migrated_pref_priority', '1')"
        ))
        conn.commit()
        if fixed:
            print(f"[migration] renumbered {fixed} preference priorities")


def _table_exists(name: str) -> bool:
    with engine.connect() as conn:
        return sa_inspect(conn).has_table(name)


try:
    # ワーカーごとに走ると ALTER TABLE や初期データ投入が衝突する。
    # 担当外のワーカーはロック解放を待つので、完了前に処理を始めることはない。
    with run_once("migrate") as first_worker:
        if first_worker:
            _auto_migrate()
            _ensure_overall_room()
            _ensure_overall_all_staff()
            _normalize_preference_priorities()
            print("[migration] Auto-migration complete")

            # 既存DBにsetup_completedがない場合、データが存在すれば自動設定
            with engine.connect() as conn:
              row = conn.execute(sa_text("SELECT value FROM app_settings WHERE key='setup_completed'")).fetchone()
              if not row:
                  data_exists = conn.execute(sa_text(
                      "SELECT 1 FROM sessions LIMIT 1"
                  )).fetchone()
                  if data_exists:
                      conn.execute(sa_text(
                          "INSERT INTO app_settings (key, value) VALUES ('setup_completed', '1')"
                      ))
                      conn.commit()
                      print("[migration] Existing data found — setup_completed auto-set")

except Exception as e:
    print(f"[migration] ERROR: {e}")
    import traceback
    traceback.print_exc()

import asyncio
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    from .scheduler import backup_scheduler_loop
    # 全ワーカーで動かすとバックアップがワーカー数だけ多重に作られる
    task = None
    if become_leader("backup"):
        task = asyncio.create_task(backup_scheduler_loop())
    elif worker_count() > 1:
        print("[scheduler] 自動バックアップは別ワーカーが担当")
    yield
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

app = FastAPI(title="Event Scheduler API", version="1.0.0", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def _validation_error(request: Request, exc: RequestValidationError):
    """入力エラーの内容に画像などのバイト列が入ると、既定の変換が例外を出して500になる"""
    errors = []
    for e in exc.errors():
        e = dict(e)
        value = e.get("input")
        if isinstance(value, (bytes, bytearray)):
            e["input"] = f"<{len(value)} bytes>"
        errors.append(e)
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": errors}))

from starlette.middleware.gzip import GZipMiddleware
# compresslevel=9 は圧縮率の割にCPUコストが高いため既定より下げる
# （xlsx/画像など圧縮済みコンテンツはそもそも縮まないので無駄が大きい）
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=5)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Public API CORS middleware (runs before global CORSMiddleware for /public/ paths)
import time as _time
from starlette.middleware.base import BaseHTTPMiddleware as _BaseHTTPMiddleware
from starlette.responses import Response as _Response

_cors_cache: dict = {"origins": "*", "ts": 0.0}
_CORS_CACHE_TTL = 60

class PublicApiCorsMiddleware(_BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if not path.startswith("/public/"):
            return await call_next(request)

        # Read allowed origins (cached)
        now = _time.time()
        if now - _cors_cache["ts"] > _CORS_CACHE_TTL:
            from .database import SessionLocal
            from .models import AppSetting
            db = SessionLocal()
            try:
                row = db.query(AppSetting).filter(AppSetting.key == "public_api_cors_origins").first()
                _cors_cache["origins"] = row.value if row and row.value else "*"
                _cors_cache["ts"] = now
            finally:
                db.close()

        allowed = _cors_cache["origins"]
        origin = request.headers.get("origin", "")

        # Determine if origin is allowed
        if allowed == "*":
            allow_origin = "*"
        elif origin:
            allowed_list = [o.strip() for o in allowed.split(",") if o.strip()]
            allow_origin = origin if origin in allowed_list else None
        else:
            allow_origin = None

        # Handle OPTIONS preflight
        if request.method == "OPTIONS" and allow_origin:
            resp = _Response(status_code=200)
            resp.headers["Access-Control-Allow-Origin"] = allow_origin
            resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            resp.headers["Access-Control-Allow-Headers"] = "X-API-Key, Content-Type"
            resp.headers["Access-Control-Max-Age"] = "3600"
            return resp

        response = await call_next(request)
        if allow_origin:
            response.headers["Access-Control-Allow-Origin"] = allow_origin
            response.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "X-API-Key, Content-Type"
        return response

app.add_middleware(PublicApiCorsMiddleware)

# Security: headers + rate limiting + auth
from .security import SecurityHeadersMiddleware, RateLimitMiddleware
app.add_middleware(SecurityHeadersMiddleware)

# 認証の内側・レート制限の外側に置く。認証を通った要求だけがキャッシュに触れ、
# キャッシュに当たった要求もレート制限の対象に残る
from .respcache import ResponseCacheMiddleware
app.add_middleware(ResponseCacheMiddleware)

app.add_middleware(RateLimitMiddleware)

import os
from .auth_middleware import AuthMiddleware
app.add_middleware(AuthMiddleware)

app.include_router(auth.router)
app.include_router(rooms.router)
app.include_router(sessions.router)
app.include_router(staffs.router)
app.include_router(assignments.router)
app.include_router(venue_maps.router)
app.include_router(export.router)
app.include_router(import_data.router)
app.include_router(backup.router)
app.include_router(settings.router)
app.include_router(categories.router)
app.include_router(session_groups.router)
app.include_router(auto_backup.router)
app.include_router(public_api.public_router)
app.include_router(public_api.admin_router)


def _seed_all():
    """初期データ投入: seed/data.json + デフォルトカテゴリ + デフォルトセッショングループ"""
    db = SessionLocal()
    try:
        # --- デフォルトカテゴリ ---
        if db.query(Category).count() == 0:
            db.add(Category(key="reception", label="受付案内", color="#388e3c", order=1))
            db.add(Category(key="social", label="懇親会", color="#7b1fa2", order=2))
            db.commit()

        # --- デフォルトセッショングループ ---
        if db.query(SessionGroup).count() == 0:
            grp = SessionGroup(label="セッション", date="", order=1, color="#1a73e8")
            db.add(grp)
            db.commit()

        # --- seed/data.json からの初期データ ---
        seed_dir = Path(__file__).resolve().parent.parent / "seed"
        seed_file = seed_dir / "data.json"
        if not seed_file.exists():
            return
        if db.query(Room).count() > 0:
            return

        with open(seed_file, encoding="utf-8") as f:
            data = json.load(f)
        if "rooms" not in data:
            return

        seed_uploads = seed_dir / "uploads"
        file_path_map: dict[str, str] = {}
        if seed_uploads.exists():
            for src_file in seed_uploads.iterdir():
                if src_file.is_file():
                    ext = src_file.suffix.lower()
                    new_name = f"{uuid.uuid4().hex}{ext}"
                    shutil.copy2(src_file, UPLOAD_DIR / new_name)
                    file_path_map[f"/uploads/{src_file.name}"] = f"/uploads/{new_name}"

        def _map_path(original: str) -> str:
            if not original:
                return ""
            return file_path_map.get(original, original)

        room_map = {}
        session_map = {}
        staff_map = {}

        for r in data.get("rooms", []):
            db_room = Room(name=r["name"], capacity=r["capacity"], floor=r.get("floor", 1))
            db.add(db_room)
            db.flush()
            room_map[r["id"]] = db_room.id

        for v in data.get("venue_maps", []):
            db.add(VenueMap(
                title=v["title"], image=_map_path(v.get("image", "")), order=v.get("order", 0),
            ))

        for s in data.get("sessions", []):
            new_room_id = room_map.get(s["room_id"], s["room_id"])
            db_sess = SessionModel(
                title=s["title"], description=s.get("description", ""),
                notes=s.get("notes", ""), speaker=s["speaker"],
                speaker_kana=s.get("speaker_kana", ""),
                speaker_photo=_map_path(s.get("speaker_photo", "")),
                speaker_org=s.get("speaker_org", ""),
                speaker_title=s.get("speaker_title", ""),
                speaker_profile=s.get("speaker_profile", ""),
                start_time=datetime.fromisoformat(s["start_time"]),
                end_time=datetime.fromisoformat(s["end_time"]),
                room_id=new_room_id,
                required_staff=s.get("required_staff", 1),
                category=s.get("category", "general"),
                english_required=s.get("english_required", 0),
            )
            db.add(db_sess)
            db.flush()
            session_map[s["id"]] = db_sess.id
            for t in s.get("lt_talks", []):
                db.add(LTTalk(
                    session_id=db_sess.id, title=t["title"], speaker=t["speaker"],
                    speaker_kana=t.get("speaker_kana", ""),
                    speaker_org=t.get("speaker_org", ""),
                    speaker_title=t.get("speaker_title", ""),
                    order=t.get("order", 0),
                ))

        for st in data.get("staffs", []):
            db_staff = Staff(
                name=st["name"], slack_name=st.get("slack_name", ""),
                photo=_map_path(st.get("photo", "")),
                english_ok=st.get("english_ok", 0),
                role=st.get("role", "general"),
                max_hours=st.get("max_hours", 8),
                experience_count=st.get("experience_count", 0),
            )
            db.add(db_staff)
            db.flush()
            staff_map[st["id"]] = db_staff.id
            for skill in st.get("skills", []):
                db.add(StaffSkill(staff_id=db_staff.id, skill=skill))
            for p in st.get("preferred_sessions", []):
                new_sess_id = session_map.get(p["session_id"])
                if new_sess_id:
                    db.add(StaffPreferredSession(
                        staff_id=db_staff.id, session_id=new_sess_id, priority=p["priority"],
                    ))
            for a in st.get("availabilities", []):
                db.add(StaffAvailability(
                    staff_id=db_staff.id,
                    start_time=datetime.fromisoformat(a["start_time"]),
                    end_time=datetime.fromisoformat(a["end_time"]),
                ))

        for a in data.get("assignments", []):
            new_sess_id = session_map.get(a["session_id"])
            new_staff_id = staff_map.get(a["staff_id"])
            if new_sess_id and new_staff_id:
                db.add(Assignment(
                    session_id=new_sess_id, staff_id=new_staff_id, role=a.get("role", "support"),
                ))

        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


_seed_all()

@app.get("/setup.html", response_class=HTMLResponse)
def setup_page():
    from .auth_middleware import is_setup_complete
    if is_setup_complete():
        return RedirectResponse(url="/login.html", status_code=302)
    html = Path("frontend/setup.html").read_text(encoding="utf-8")
    return HTMLResponse(content=html)


@app.get("/login.html", response_class=HTMLResponse)
def login_page():
    db = SessionLocal()
    try:
        row = db.query(AppSetting).filter(AppSetting.key == "app_title").first()
        title = row.value if row and row.value else "Event Scheduler"
    finally:
        db.close()
    html = Path("frontend/login.html").read_text(encoding="utf-8")
    html = html.replace("{{APP_TITLE}}", title)
    return HTMLResponse(content=html)


class CachedStaticFiles(StaticFiles):
    """静的ファイルにCache-Controlを付与する（ETagによる再検証も併用）"""

    def __init__(self, *args, max_age: int = 3600, **kwargs):
        self.max_age = max_age
        super().__init__(*args, **kwargs)

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = f"public, max-age={self.max_age}"
        return resp


# アップロード画像はファイル名がランダムで更新時は別名になるため長めにキャッシュ
app.mount("/uploads", CachedStaticFiles(directory=str(UPLOAD_DIR), max_age=86400), name="uploads")
app.mount("/", CachedStaticFiles(directory="frontend", html=True, max_age=300), name="frontend")
