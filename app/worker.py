"""複数ワーカーで動かすためのプロセス間調整。

gunicorn はワーカーごとにアプリを読み込むため、起動時マイグレーションや
自動バックアップがワーカー数だけ多重に走る。ここではファイルロックで
「1プロセスだけ実行する」「1プロセスが終わるまで待つ」を提供する。

ロックファイルはコンテナ内のローカルパスに置く。共有ストレージ上だと
CIFS の nobrl などロック実装の差に左右されるため。
"""

import os
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # 非POSIX環境
    fcntl = None

LOCK_DIR = Path(os.environ.get("LOCK_DIR", "/tmp"))

# ロックはプロセスが生きている間ずっと保持する必要があるため、
# ファイルオブジェクトを手放さないよう保管する
_held: dict[str, object] = {}


def worker_count() -> int:
    """gunicorn のワーカー数"""
    try:
        return max(1, int(os.environ.get("WEB_CONCURRENCY", "1")))
    except ValueError:
        return 1


def _lock_path(name: str) -> Path:
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    return LOCK_DIR / f"confsched-{name}.lock"


def become_leader(name: str) -> bool:
    """最初に取れたワーカーだけ True を返す。単一ワーカーなら常に True"""
    if fcntl is None or worker_count() == 1:
        return True
    f = open(_lock_path(name), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return False
    _held[name] = f
    return True


@contextmanager
def exclusive(name: str):
    """1ワーカーずつ順に実行する。他のワーカーは完了を待ってから入る"""
    if fcntl is None or worker_count() == 1:
        yield
        return
    with open(_lock_path(name), "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


@contextmanager
def run_once(name: str):
    """最初の1ワーカーだけ True。他は完了を待ってから False で抜ける。

    完了印はコンテナ内のローカルパスに置くため、コンテナを起動し直せば再び実行される。
    """
    if fcntl is None or worker_count() == 1:
        yield True
        return
    marker = _lock_path(name).with_suffix(".done")
    with open(_lock_path(name), "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            if marker.exists():
                yield False
            else:
                yield True
                marker.write_text("done")
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
