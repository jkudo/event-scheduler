"""Background auto-backup scheduler using asyncio."""

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path

from .config import BACKUP_DIR, now as app_now
from .database import SessionLocal
from .routers.backup import create_backup_zip

# Runtime state (read by status endpoint)
scheduler_state = {
    "running": False,
    "last_run": None,
    "last_result": None,
    "next_run": None,
    "error": None,
}

METADATA_FILE = BACKUP_DIR / "metadata.json"


def _read_metadata() -> list[dict]:
    if METADATA_FILE.exists():
        try:
            return json.loads(METADATA_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
    return []


def _write_metadata(entries: list[dict]):
    METADATA_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")


def _get_setting(db, key: str, default: str = "") -> str:
    from .models import AppSetting
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else default


def run_backup(trigger: str = "auto") -> dict:
    """Execute a backup synchronously. Returns metadata entry."""
    now = app_now()
    backup_id = now.strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{backup_id}.zip"
    filepath = BACKUP_DIR / filename

    db = SessionLocal()
    try:
        zip_bytes = create_backup_zip(db)
        filepath.write_bytes(zip_bytes)

        entry = {
            "id": backup_id,
            "filename": filename,
            "created_at": now.isoformat(),
            "size_bytes": len(zip_bytes),
            "trigger": trigger,
            "status": "ok",
        }

        # Append to metadata
        metadata = _read_metadata()
        metadata.append(entry)
        _write_metadata(metadata)

        # Enforce retention
        retention = int(_get_setting(db, "autobackup_retention_count", "28"))
        _enforce_retention(retention)

        return entry
    except Exception as e:
        return {
            "id": backup_id,
            "filename": filename,
            "created_at": now.isoformat(),
            "size_bytes": 0,
            "trigger": trigger,
            "status": "error",
            "error": str(e),
        }
    finally:
        db.close()


def _enforce_retention(max_count: int):
    """Delete oldest backups beyond retention count."""
    metadata = _read_metadata()
    if len(metadata) <= max_count:
        return

    # Sort by created_at, keep newest
    metadata.sort(key=lambda x: x["created_at"])
    to_delete = metadata[:-max_count]
    to_keep = metadata[-max_count:]

    for entry in to_delete:
        fpath = BACKUP_DIR / entry["filename"]
        if fpath.exists():
            fpath.unlink()

    _write_metadata(to_keep)


def _calc_next_daily(daily_time: str) -> datetime:
    """Calculate the next occurrence of a daily time (HH:MM)."""
    from datetime import timedelta
    now = app_now()
    try:
        hour, minute = map(int, daily_time.split(":"))
    except (ValueError, AttributeError):
        hour, minute = 3, 0
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target


async def backup_scheduler_loop():
    """Main scheduler loop — runs as asyncio background task."""
    scheduler_state["running"] = True
    print("[scheduler] Auto-backup scheduler started")

    try:
        while True:
            db = SessionLocal()
            try:
                enabled = _get_setting(db, "autobackup_enabled", "0") == "1"
                schedule_type = _get_setting(db, "autobackup_schedule_type", "interval")
                interval_minutes = int(_get_setting(db, "autobackup_interval_minutes", "720"))
                daily_time = _get_setting(db, "autobackup_daily_time", "03:00")
            finally:
                db.close()

            if not enabled:
                scheduler_state["next_run"] = None
                await asyncio.sleep(30)
                continue

            if schedule_type == "daily":
                # Daily mode: run at specific time
                next_run = _calc_next_daily(daily_time)
                scheduler_state["next_run"] = next_run.isoformat()
                wait_seconds = (next_run - app_now()).total_seconds()
                if wait_seconds > 0:
                    await asyncio.sleep(min(wait_seconds, 30))
                    if wait_seconds > 30:
                        continue
                # Time to run
                try:
                    result = await asyncio.get_event_loop().run_in_executor(None, run_backup, "auto")
                    scheduler_state["last_run"] = time.time()
                    scheduler_state["last_result"] = result
                    scheduler_state["error"] = None
                    scheduler_state["next_run"] = _calc_next_daily(daily_time).isoformat()
                    print(f"[scheduler] Daily backup completed: {result.get('filename')} ({result.get('status')})")
                except Exception as e:
                    scheduler_state["error"] = str(e)
                    scheduler_state["last_run"] = time.time()
                    print(f"[scheduler] Daily backup failed: {e}")
                await asyncio.sleep(60)  # avoid re-trigger within same minute
            else:
                # Interval mode
                interval_seconds = max(interval_minutes * 60, 600)

                last = scheduler_state.get("last_run")
                if last:
                    elapsed = time.time() - last
                    if elapsed < interval_seconds:
                        remaining = interval_seconds - elapsed
                        scheduler_state["next_run"] = datetime.fromtimestamp(time.time() + remaining, tz=app_now().tzinfo).isoformat()
                        await asyncio.sleep(min(remaining, 30))
                        continue

                scheduler_state["next_run"] = None
                try:
                    result = await asyncio.get_event_loop().run_in_executor(None, run_backup, "auto")
                    scheduler_state["last_run"] = time.time()
                    scheduler_state["last_result"] = result
                    scheduler_state["error"] = None
                    scheduler_state["next_run"] = datetime.fromtimestamp(
                        time.time() + interval_seconds, tz=app_now().tzinfo
                    ).isoformat()
                    print(f"[scheduler] Backup completed: {result.get('filename')} ({result.get('status')})")
                except Exception as e:
                    scheduler_state["error"] = str(e)
                    scheduler_state["last_run"] = time.time()
                    print(f"[scheduler] Backup failed: {e}")

                await asyncio.sleep(interval_seconds)

    except asyncio.CancelledError:
        print("[scheduler] Auto-backup scheduler stopped")
    finally:
        scheduler_state["running"] = False
