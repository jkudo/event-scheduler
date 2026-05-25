"""Shared utility functions used across routers."""

from .models import Staff, Session as SessionModel


def is_staff_available(staff: Staff, session: SessionModel) -> bool:
    """スタッフの活動可能時間内にセッションが収まるかチェック"""
    if not staff.availabilities:
        return True  # 活動可能時間が未設定なら制約なし
    for avail in staff.availabilities:
        if avail.start_time <= session.start_time and avail.end_time >= session.end_time:
            return True
    return False
