from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from .config import DATABASE_URL, IS_SQLITE

# 同期エンドポイントはスレッドプール（既定40スレッド）で動くため、
# 既定のプール（5+10）だと同時アクセスが増えたときに枯渇して待たされる
_engine_args = {
    "pool_size": 20,
    "max_overflow": 40,
    "pool_timeout": 10,
    "pool_recycle": 1800,
}
if IS_SQLITE:
    # SQLite は同一コネクションを別スレッドから使うため無効化が必要
    _engine_args["connect_args"] = {"check_same_thread": False}
else:
    # 切断済みのコネクションを掴まないよう、使う前に生存確認する
    _engine_args["pool_pre_ping"] = True

engine = create_engine(DATABASE_URL, **_engine_args)


if IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        """同時アクセス時の database is locked を防ぐ（WAL + ロック待ち30秒）"""
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA busy_timeout=30000")  # WAL切替自体もロック待ちし得るため先に設定
        try:
            # ネットワークファイルシステム（Azure Files 等）では WAL を使えないため、
            # 失敗しても既定のジャーナルモードのまま動作させる
            cur.execute("PRAGMA journal_mode=WAL")
        except Exception:
            pass
        cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
