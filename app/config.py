import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DATA_DIR = Path(os.environ.get("DATA_DIR", "."))
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR = DATA_DIR / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_URL = f"sqlite:///{DATA_DIR}/scheduler.db"

# ---------------------------------------------------------------------------
# Timezone helper
# ---------------------------------------------------------------------------
_tz_cache: ZoneInfo | None = None
_tz_loaded: bool = False


def get_app_tz() -> ZoneInfo:
    """app_settings の timezone 値からタイムゾーンを取得（キャッシュ付き）"""
    global _tz_cache, _tz_loaded
    if _tz_loaded:
        return _tz_cache or ZoneInfo("Asia/Tokyo")
    try:
        from .database import SessionLocal
        from .models import AppSetting
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == "timezone").first()
            tz_name = row.value if row and row.value else "Asia/Tokyo"
            _tz_cache = ZoneInfo(tz_name)
        finally:
            db.close()
    except Exception:
        _tz_cache = ZoneInfo("Asia/Tokyo")
    _tz_loaded = True
    return _tz_cache


def reload_tz():
    """タイムゾーン設定変更後にキャッシュをクリア"""
    global _tz_cache, _tz_loaded
    _tz_cache = None
    _tz_loaded = False


def now() -> datetime:
    """アプリのタイムゾーンで現在時刻を返す"""
    return datetime.now(get_app_tz())
