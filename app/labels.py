"""カテゴリ・担当のラベル辞書。エクスポートとインポートで共用する。"""

import json

from sqlalchemy.orm import Session

from .models import AppSetting, Category

SESSION_CATS = ("general", "tech", "workshop", "keynote", "keynote_multi", "lt", "panel")
MULTI_SPEAKER_CATS = ("lt", "panel", "keynote_multi")
ROLE_LABELS_BASE = {"session": "セッション"}
CAT_LABELS_BASE = {
    "general": "一般", "tech": "技術", "workshop": "ワークショップ",
    "keynote": "基調講演", "keynote_multi": "基調講演（複数人）",
    "lt": "LT", "panel": "パネルディスカッション", "overall": "全体",
}


def _load_json_setting(db: Session, key: str) -> list:
    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    try:
        return json.loads(row.value) if row and row.value else []
    except ValueError:
        return []


def build_label_maps(db: Session) -> tuple[dict, dict, set]:
    """(CAT_LABELS, ROLE_LABELS, multi_speaker_cats) を返す。

    合成順: 基本ラベル → Category テーブル → AppSetting(session_categories / custom_roles)。
    後から合成したユーザー定義が同キーを上書きする。
    """
    db_categories = db.query(Category).order_by(Category.order, Category.id).all()
    cat_labels = {**CAT_LABELS_BASE, **{c.key: c.label for c in db_categories}}
    role_labels = {**ROLE_LABELS_BASE, **{c.key: c.label for c in db_categories}}

    extra_session_cats = _load_json_setting(db, "session_categories")
    cat_labels.update({c["key"]: c["label"] for c in extra_session_cats})
    # 「複数登壇者」を選んで追加した形式も lt_talks を展開する
    multi_speaker_cats = set(MULTI_SPEAKER_CATS) | {
        c["key"] for c in extra_session_cats if c.get("multi")
    }

    custom_roles = _load_json_setting(db, "custom_roles")
    role_labels.update({r["key"]: r["label"] for r in custom_roles})

    return cat_labels, role_labels, multi_speaker_cats
