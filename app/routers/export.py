import io
import json
import os
import shutil
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, UploadFile, File
from pydantic import BaseModel
from fastapi.responses import StreamingResponse, JSONResponse
from openpyxl import Workbook
from openpyxl.drawing.image import Image as XlImage
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from PIL import Image as PILImage
from sqlalchemy.orm import Session, joinedload

from ..config import UPLOAD_DIR
from ..database import get_db
from ..models import (
    Session as SessionModel, Staff, Assignment, Room, VenueMap,
    LTTalk, StaffSkill, StaffPreferredSession, StaffAvailability, Category, SessionGroup,
)
router = APIRouter(prefix="/api/export", tags=["export"])

HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
HEADER_FILL = PatternFill(start_color="1A73E8", end_color="1A73E8", fill_type="solid")
HEADER_FILL_GREEN = PatternFill(start_color="388E3C", end_color="388E3C", fill_type="solid")
HEADER_FILL_PURPLE = PatternFill(start_color="7B1FA2", end_color="7B1FA2", fill_type="solid")
HEADER_FILL_ORANGE = PatternFill(start_color="E65100", end_color="E65100", fill_type="solid")
HEADER_FILL_TEAL = PatternFill(start_color="00695C", end_color="00695C", fill_type="solid")
HEADER_FILL_BROWN = PatternFill(start_color="5D4037", end_color="5D4037", fill_type="solid")
HEADER_FILL_INDIGO = PatternFill(start_color="283593", end_color="283593", fill_type="solid")
THIN_BORDER = Border(
    left=Side(style="thin"), right=Side(style="thin"),
    top=Side(style="thin"), bottom=Side(style="thin"),
)
WRAP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center")

SESSION_CATS = ("general", "tech", "workshop", "keynote", "lt")
ROLE_LABELS_BASE = {"session": "セッション"}
CAT_LABELS_BASE = {
    "general": "一般", "tech": "技術", "workshop": "ワークショップ",
    "keynote": "基調講演", "lt": "LT", "overall": "全体",
}

PHOTO_PX = 48  # Excel内の写真サイズ (px)
ROW_HEIGHT_WITH_PHOTO = 45  # 写真付き行の高さ (pt)


def _fmt(dt: datetime | None) -> str:
    if not dt:
        return ""
    return dt.strftime("%H:%M")


def _fmt_full(dt: datetime | None) -> str:
    if not dt:
        return ""
    return dt.strftime("%Y/%m/%d %H:%M")


def _apply_header(ws, row, fill=HEADER_FILL):
    for cell in ws[row]:
        cell.font = HEADER_FONT
        cell.fill = fill
        cell.alignment = CENTER
        cell.border = THIN_BORDER


def _apply_border(ws, row):
    for cell in ws[row]:
        cell.border = THIN_BORDER
        cell.alignment = WRAP


def _auto_width(ws):
    for col in ws.columns:
        max_len = 0
        col_letter = col[0].column_letter
        for cell in col:
            try:
                val = str(cell.value or "")
                length = sum(2 if ord(c) > 127 else 1 for c in val)
                max_len = max(max_len, length)
            except Exception:
                pass
        ws.column_dimensions[col_letter].width = min(max_len + 3, 50)


def _add_photo(ws, photo_path: str, col: int, row: int):
    """ワークシートのセルに元画像をそのまま埋め込む（セル内に収まるようリサイズ表示）"""
    file_path = Path("." + photo_path)
    if not file_path.exists():
        return
    try:
        img = PILImage.open(file_path)
        img.verify()  # 画像ファイルとして有効か確認
    except Exception:
        return
    xl_img = XlImage(str(file_path))
    xl_img.width = PHOTO_PX
    xl_img.height = PHOTO_PX
    cell_ref = f"{get_column_letter(col)}{row}"
    ws.add_image(xl_img, cell_ref)
    ws.row_dimensions[row].height = ROW_HEIGHT_WITH_PHOTO


@router.get("/excel")
def export_excel(db: Session = Depends(get_db)):
    """タブ構成に合わせてExcelファイルをエクスポート"""

    # データ取得
    rooms = db.query(Room).order_by(Room.id).all()
    sessions = (
        db.query(SessionModel)
        .options(
            joinedload(SessionModel.room),
            joinedload(SessionModel.lt_talks),
            joinedload(SessionModel.assignments).joinedload(Assignment.staff).joinedload(Staff.skills),
        )
        .order_by(SessionModel.start_time)
        .all()
    )
    staffs = (
        db.query(Staff)
        .options(
            joinedload(Staff.availabilities),
            joinedload(Staff.preferred_sessions),
            joinedload(Staff.assignments).joinedload(Assignment.session).joinedload(SessionModel.room),
        )
        .order_by(Staff.id)
        .all()
    )

    # 動的カテゴリ取得
    db_categories = db.query(Category).order_by(Category.order, Category.id).all()
    db_session_groups = db.query(SessionGroup).order_by(SessionGroup.order, SessionGroup.id).all()
    dynamic_cat_keys = [c.key for c in db_categories]
    CAT_LABELS = {**CAT_LABELS_BASE, **{c.key: c.label for c in db_categories}}
    ROLE_LABELS = {**ROLE_LABELS_BASE, **{c.key: c.label for c in db_categories}}

    def _cat_header_fill(color_hex: str) -> PatternFill:
        """カテゴリの色からヘッダー用PatternFillを生成"""
        c = color_hex.lstrip("#").upper()
        return PatternFill(start_color=c, end_color=c, fill_type="solid")

    cat_fill_map = {c.key: _cat_header_fill(c.color) for c in db_categories}

    wb = Workbook()

    # ============================================================
    # Sheet 1: 部屋管理
    # ============================================================
    ws1 = wb.active
    ws1.title = "部屋管理"
    ws1.append(["ID", "部屋名", "定員", "階"])
    _apply_header(ws1, 1, HEADER_FILL_BROWN)

    for r in rooms:
        ws1.append([r.id, r.name, r.capacity, r.floor])
        _apply_border(ws1, ws1.max_row)

    _auto_width(ws1)

    # ============================================================
    # Sheet 2: セッション管理 (動的カテゴリ除外, 写真付き)
    # ============================================================
    group_label_map = {g.id: g.label for g in db_session_groups}
    ws2 = wb.create_sheet("セッション管理")
    ws2.append(["ID", "写真", "タイトル", "登壇者", "ふりがな", "所属", "肩書き", "開始", "終了", "部屋", "カテゴリ", "グループ", "必要人数", "英語", "説明", "備考"])
    _apply_header(ws2, 1)
    # 写真列の幅を確保
    ws2.column_dimensions["B"].width = 9

    for s in sessions:
        if s.category not in SESSION_CATS:
            continue
        if s.category == "lt" and s.lt_talks:
            speakers = "\n".join(
                f"{t.speaker}（{t.title}）" + (f" {t.start_time}〜{t.end_time}" if t.start_time else "")
                for t in s.lt_talks
            )
        else:
            speakers = s.speaker
        ws2.append([
            s.id,
            "",  # 写真列（画像で上書き）
            s.title,
            speakers,
            s.speaker_kana,
            s.speaker_org,
            s.speaker_title,
            _fmt_full(s.start_time),
            _fmt_full(s.end_time),
            s.room.name if s.room else "",
            CAT_LABELS.get(s.category, s.category),
            group_label_map.get(s.group_id, ""),
            s.required_staff,
            "○" if s.english_required else "",
            s.description,
            s.notes,
        ])
        _apply_border(ws2, ws2.max_row)
        if s.speaker_photo:
            _add_photo(ws2, s.speaker_photo, col=2, row=ws2.max_row)

    _auto_width(ws2)
    ws2.column_dimensions["B"].width = 9  # auto_widthで上書きされるので再設定

    # ============================================================
    # Sheet 3: スタッフ管理
    # ============================================================
    ws3 = wb.create_sheet("スタッフ管理")
    ws3.append(["ID", "名前", "Slack名", "担当", "経験回数", "英語", "最大稼働時間", "活動可能時間", "担当セッション数"])
    _apply_header(ws3, 1, HEADER_FILL_ORANGE)

    for st in staffs:
        avails = " / ".join(
            f"{_fmt(a.start_time)}-{_fmt(a.end_time)}" for a in st.availabilities
        )
        ws3.append([
            st.id,
            st.name,
            st.slack_name,
            ROLE_LABELS.get(st.role, st.role),
            st.experience_count,
            "○" if st.english_ok else "",
            f"{st.max_hours}h",
            avails,
            len(st.assignments),
        ])
        _apply_border(ws3, ws3.max_row)

    _auto_width(ws3)

    # ============================================================
    # Sheet 4: セッション配置 (写真付き)
    # ============================================================
    ws4 = wb.create_sheet("セッション配置")
    ws4.append(["時間", "部屋", "写真", "タイトル", "登壇者", "カテゴリ", "必要人数", "配置人数", "英語", "担当スタッフ", "備考"])
    _apply_header(ws4, 1, HEADER_FILL_TEAL)
    ws4.column_dimensions["C"].width = 9

    for s in sessions:
        if s.category not in SESSION_CATS:
            continue
        staff_names = ", ".join(a.staff.name for a in s.assignments)
        assigned_count = len(s.assignments)
        status = "○" if assigned_count >= s.required_staff else f"不足({assigned_count}/{s.required_staff})"
        ws4.append([
            f"{_fmt(s.start_time)}-{_fmt(s.end_time)}",
            s.room.name if s.room else "",
            "",  # 写真列
            s.title,
            s.speaker,
            CAT_LABELS.get(s.category, s.category),
            s.required_staff,
            status,
            "○" if s.english_required else "",
            staff_names,
            s.notes,
        ])
        _apply_border(ws4, ws4.max_row)
        if s.speaker_photo:
            _add_photo(ws4, s.speaker_photo, col=3, row=ws4.max_row)

    _auto_width(ws4)
    ws4.column_dimensions["C"].width = 9

    # ============================================================
    # Sheet 5: 全体スケジュール (マトリクス忠実再現)
    # ============================================================
    ws5 = wb.create_sheet("全体スケジュール")
    room_list = sorted(rooms, key=lambda r: r.id)

    # --- フロントエンドと同じ列構成を構築 ---
    overall_sessions = [s for s in sessions if s.category == "overall"]
    session_only = [s for s in sessions if s.category in SESSION_CATS]
    # 動的カテゴリ別セッション
    cat_sessions_map = {ck: [s for s in sessions if s.category == ck] for ck in dynamic_cat_keys}
    all_schedule = overall_sessions + session_only
    for ck in dynamic_cat_keys:
        all_schedule += cat_sessions_map[ck]

    has_overall = len(overall_sessions) > 0
    # セッション部屋 (overall/動的カテゴリ 除外)
    sess_room_ids = dict.fromkeys(s.room_id for s in session_only if s.room)
    sess_rooms = [r for r in room_list if r.id in sess_room_ids]

    # 列定義: (type, label, fill, room_id_or_None)
    columns = []
    if has_overall:
        columns.append(("overall", "全体", HEADER_FILL_ORANGE, None))
    for r in sess_rooms:
        columns.append(("session", r.name, HEADER_FILL_INDIGO, r.id))
    # 動的カテゴリの部屋列
    for cat_obj in db_categories:
        ck = cat_obj.key
        cat_room_ids = dict.fromkeys(s.room_id for s in cat_sessions_map[ck] if s.room)
        cat_rooms = [r for r in room_list if r.id in cat_room_ids]
        fill = cat_fill_map[ck]
        for r in cat_rooms:
            columns.append((ck, f"{cat_obj.label}: {r.name}", fill, r.id))

    if not all_schedule:
        _auto_width(ws5)
    else:
        # --- 15分刻みの時間スロットを生成 ---
        from datetime import timedelta
        SLOT_MINUTES = 15
        slot_delta = timedelta(minutes=SLOT_MINUTES)

        all_starts = [s.start_time for s in all_schedule]
        all_ends = [s.end_time for s in all_schedule]
        min_time = min(all_starts)
        max_time = max(all_ends)
        # 15分単位に丸める
        min_time = min_time.replace(minute=(min_time.minute // SLOT_MINUTES) * SLOT_MINUTES, second=0, microsecond=0)
        if max_time.minute % SLOT_MINUTES:
            max_time = max_time.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1 if max_time.minute > 45 else 0, minutes=((max_time.minute // SLOT_MINUTES) + 1) * SLOT_MINUTES if max_time.minute % SLOT_MINUTES else 0)
        max_time = max_time.replace(second=0, microsecond=0)
        # もう少し安全に丸める
        import math
        max_minutes = max_time.hour * 60 + max_time.minute
        max_minutes = math.ceil(max_minutes / SLOT_MINUTES) * SLOT_MINUTES
        max_time = max_time.replace(hour=max_minutes // 60, minute=max_minutes % 60, second=0, microsecond=0)

        slots = []
        t = min_time
        while t < max_time:
            slots.append(t)
            t += slot_delta

        HEADER_ROW = 1
        DATA_START = 2  # データ開始行

        # --- ヘッダー行 ---
        ws5.cell(row=HEADER_ROW, column=1, value="時間")
        ws5.cell(row=HEADER_ROW, column=1).font = HEADER_FONT
        ws5.cell(row=HEADER_ROW, column=1).fill = HEADER_FILL_INDIGO
        ws5.cell(row=HEADER_ROW, column=1).alignment = CENTER
        ws5.cell(row=HEADER_ROW, column=1).border = THIN_BORDER

        for ci, (ctype, clabel, cfill, _) in enumerate(columns):
            cell = ws5.cell(row=HEADER_ROW, column=ci + 2, value=clabel)
            cell.font = HEADER_FONT
            cell.fill = cfill
            cell.alignment = CENTER
            cell.border = THIN_BORDER

        # --- 時間ラベル (30分ごとに表示、15分スロットはセル結合) ---
        slot_row_map = {}  # slot_time -> excel_row
        for si, slot_t in enumerate(slots):
            excel_row = DATA_START + si
            slot_row_map[slot_t] = excel_row
            # 背景セルにボーダー
            for ci in range(len(columns)):
                cell = ws5.cell(row=excel_row, column=ci + 2, value="")
                cell.border = THIN_BORDER
            # 時間ラベル
            time_cell = ws5.cell(row=excel_row, column=1, value="")
            time_cell.border = THIN_BORDER
            time_cell.alignment = Alignment(horizontal="center", vertical="top")
            if slot_t.minute == 0 or slot_t.minute == 30:
                time_cell.value = _fmt(slot_t)
                time_cell.font = Font(bold=True, size=9)

        ws5.column_dimensions["A"].width = 8
        # 行高さ設定
        for si in range(len(slots)):
            ws5.row_dimensions[DATA_START + si].height = 20

        # --- カテゴリ別の色定義 ---
        CAT_FILL = {
            "overall": PatternFill(start_color="FFF3E0", end_color="FFF3E0", fill_type="solid"),
            "general": PatternFill(start_color="E8F0FE", end_color="E8F0FE", fill_type="solid"),
            "tech": PatternFill(start_color="E8F0FE", end_color="E8F0FE", fill_type="solid"),
            "workshop": PatternFill(start_color="E8F0FE", end_color="E8F0FE", fill_type="solid"),
            "keynote": PatternFill(start_color="E8F0FE", end_color="E8F0FE", fill_type="solid"),
            "lt": PatternFill(start_color="E8F0FE", end_color="E8F0FE", fill_type="solid"),
        }
        CAT_FONT_COLOR = {
            "overall": "E65100",
            "general": "1A73E8", "tech": "1A73E8", "workshop": "1A73E8",
            "keynote": "1A73E8", "lt": "1A73E8",
        }
        # 動的カテゴリの色を追加
        for cat_obj in db_categories:
            ck = cat_obj.key
            # 薄い背景色を生成（元の色を薄くする）
            hex_color = cat_obj.color.lstrip("#").upper()
            # セル背景: 薄い色
            r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
            lr = min(255, r + (255 - r) * 85 // 100)
            lg = min(255, g + (255 - g) * 85 // 100)
            lb = min(255, b + (255 - b) * 85 // 100)
            light_hex = f"{lr:02X}{lg:02X}{lb:02X}"
            CAT_FILL[ck] = PatternFill(start_color=light_hex, end_color=light_hex, fill_type="solid")
            CAT_FONT_COLOR[ck] = hex_color

        # --- セッションをマトリクスに配置 (セル結合) ---
        for s in all_schedule:
            cat = s.category
            # 対応する列を見つける
            col_idx = None
            if cat == "overall":
                for ci, (ctype, _, _, _) in enumerate(columns):
                    if ctype == "overall":
                        col_idx = ci + 2
                        break
            elif cat in dynamic_cat_keys:
                for ci, (ctype, _, _, rid) in enumerate(columns):
                    if ctype == cat and rid == s.room_id:
                        col_idx = ci + 2
                        break
            else:  # session categories
                for ci, (ctype, _, _, rid) in enumerate(columns):
                    if ctype == "session" and rid == s.room_id:
                        col_idx = ci + 2
                        break

            if col_idx is None:
                continue

            # 行範囲を計算
            start_row = None
            end_row = None
            for slot_t, row in slot_row_map.items():
                if slot_t >= s.start_time and start_row is None:
                    start_row = row
                if slot_t < s.end_time:
                    end_row = row

            if start_row is None or end_row is None:
                # スロット範囲外 - 最も近いスロットを使う
                slot_times_list = sorted(slot_row_map.keys())
                if s.start_time <= slot_times_list[0]:
                    start_row = slot_row_map[slot_times_list[0]]
                else:
                    for st in slot_times_list:
                        if st <= s.start_time:
                            start_row = slot_row_map[st]
                if s.end_time >= slot_times_list[-1]:
                    end_row = slot_row_map[slot_times_list[-1]]
                else:
                    for st in slot_times_list:
                        if st < s.end_time:
                            end_row = slot_row_map[st]

            if start_row is None or end_row is None:
                continue

            # セル内容を構築
            staff_names = ", ".join(a.staff.name for a in s.assignments)
            time_str = f"{_fmt(s.start_time)}-{_fmt(s.end_time)}"
            if cat == "overall":
                content = f"{s.title}\n{time_str}"
                if s.notes:
                    content += f"\n{s.notes}"
            else:
                content = f"{s.title}\n{time_str}"
                if staff_names:
                    content += f"\n【{staff_names}】"
                if not s.assignments and s.required_staff > 0:
                    content += "\n※未配置"

            # セル結合と書式設定
            if end_row > start_row:
                ws5.merge_cells(
                    start_row=start_row, start_column=col_idx,
                    end_row=end_row, end_column=col_idx,
                )

            cell = ws5.cell(row=start_row, column=col_idx, value=content)
            fill = CAT_FILL.get(cat, CAT_FILL["general"])
            font_color = CAT_FONT_COLOR.get(cat, "333333")
            cell.fill = fill
            cell.font = Font(size=9, color=font_color)
            cell.alignment = Alignment(wrap_text=True, vertical="top", horizontal="left")
            cell.border = THIN_BORDER

            # 結合セルの右下ボーダーも設定
            if end_row > start_row:
                for r in range(start_row, end_row + 1):
                    border_cell = ws5.cell(row=r, column=col_idx)
                    border_cell.border = THIN_BORDER

        # 列幅設定
        for ci, (ctype, clabel, _, _) in enumerate(columns):
            col_letter = get_column_letter(ci + 2)
            label_len = sum(2 if ord(c) > 127 else 1 for c in clabel)
            ws5.column_dimensions[col_letter].width = max(label_len + 2, 18)

    # ============================================================
    # 動的カテゴリ別シート
    # ============================================================
    for cat_obj in db_categories:
        ws_cat = wb.create_sheet(cat_obj.label)
        ws_cat.append(["タイトル", "時間", "場所", "英語", "必要人数", "配置人数", "担当スタッフ", "備考"])
        _apply_header(ws_cat, 1, cat_fill_map[cat_obj.key])

        for s in sessions:
            if s.category != cat_obj.key:
                continue
            staff_names = ", ".join(a.staff.name for a in s.assignments)
            assigned_count = len(s.assignments)
            status = "○" if assigned_count >= s.required_staff else f"不足({assigned_count}/{s.required_staff})"
            ws_cat.append([
                s.title,
                f"{_fmt(s.start_time)}-{_fmt(s.end_time)}",
                s.room.name if s.room else "",
                "○" if s.english_required else "",
                s.required_staff,
                status,
                staff_names,
                s.notes,
            ])
            _apply_border(ws_cat, ws_cat.max_row)

        _auto_width(ws_cat)

    # Excelファイルをバイトストリームに書き出し
    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)

    now = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"conference_schedule_{now}.xlsx"

    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ================================================================
#  バックアップ (ZIP エクスポート / インポート)
#  ZIP 構成: data.json + uploads/ フォルダ（画像ファイル）
# ================================================================

def _dt_str(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


@router.get("/backup")
def export_backup(db: Session = Depends(get_db)):
    """全データを ZIP でエクスポート（data.json + 画像ファイル）"""
    rooms = db.query(Room).order_by(Room.id).all()
    venue_maps = db.query(VenueMap).order_by(VenueMap.id).all()
    sessions = (
        db.query(SessionModel)
        .options(joinedload(SessionModel.lt_talks))
        .order_by(SessionModel.id)
        .all()
    )
    staffs = (
        db.query(Staff)
        .options(
            joinedload(Staff.skills),
            joinedload(Staff.preferred_sessions),
            joinedload(Staff.availabilities),
        )
        .order_by(Staff.id)
        .all()
    )
    assignments = db.query(Assignment).order_by(Assignment.id).all()
    categories = db.query(Category).order_by(Category.order, Category.id).all()
    session_groups = db.query(SessionGroup).order_by(SessionGroup.order, SessionGroup.id).all()
    app_settings = db.query(AppSetting).all()

    data = {
        "version": 4,
        "exported_at": datetime.now().isoformat(),
        "categories": [
            {"id": c.id, "key": c.key, "label": c.label, "color": c.color, "order": c.order}
            for c in categories
        ],
        "session_groups": [
            {"id": g.id, "label": g.label, "date": g.date, "order": g.order, "color": g.color}
            for g in session_groups
        ],
        "rooms": [
            {"id": r.id, "name": r.name, "capacity": r.capacity, "floor": r.floor}
            for r in rooms
        ],
        "venue_maps": [
            {"id": v.id, "title": v.title, "order": v.order, "image": v.image}
            for v in venue_maps
        ],
        "sessions": [
            {
                "id": s.id, "title": s.title, "description": s.description,
                "notes": s.notes, "speaker": s.speaker,
                "speaker_kana": s.speaker_kana,
                "speaker_org": s.speaker_org, "speaker_title": s.speaker_title,
                "speaker_profile": s.speaker_profile,
                "speaker_photo": s.speaker_photo,
                "start_time": _dt_str(s.start_time), "end_time": _dt_str(s.end_time),
                "room_id": s.room_id, "required_staff": s.required_staff,
                "category": s.category, "english_required": s.english_required,
                "group_id": s.group_id,
                "lt_talks": [
                    {
                        "id": t.id, "title": t.title, "speaker": t.speaker,
                        "speaker_kana": t.speaker_kana,
                        "speaker_org": t.speaker_org,
                        "speaker_title": t.speaker_title,
                        "speaker_photo": t.speaker_photo,
                        "start_time": t.start_time,
                        "end_time": t.end_time,
                        "order": t.order,
                    }
                    for t in s.lt_talks
                ],
            }
            for s in sessions
        ],
        "staffs": [
            {
                "id": st.id, "name": st.name, "slack_name": st.slack_name,
                "photo": st.photo,
                "english_ok": st.english_ok, "role": st.role,
                "max_hours": st.max_hours, "experience_count": st.experience_count,
                "skills": [sk.skill for sk in st.skills],
                "preferred_sessions": [
                    {"session_id": p.session_id, "priority": p.priority}
                    for p in st.preferred_sessions
                ],
                "availabilities": [
                    {"start_time": _dt_str(a.start_time), "end_time": _dt_str(a.end_time)}
                    for a in st.availabilities
                ],
            }
            for st in staffs
        ],
        "assignments": [
            {"id": a.id, "session_id": a.session_id, "staff_id": a.staff_id, "role": a.role}
            for a in assignments
        ],
        "settings": [
            {"key": s.key, "value": s.value}
            for s in app_settings
        ],
    }

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zf:
        # data.json
        zf.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=2))
        # 画像ファイルを uploads/ に格納
        if UPLOAD_DIR.exists():
            for file_path in UPLOAD_DIR.iterdir():
                if file_path.is_file():
                    zf.write(file_path, f"uploads/{file_path.name}")

    stream.seek(0)
    now = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"conf_backup_{now}.zip"

    return StreamingResponse(
        stream,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/restore")
async def import_backup(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """ZIP バックアップから全データを復元（既存データは全削除）"""
    raw = await file.read()
    buf = io.BytesIO(raw)

    # ZIP を展開して data.json を読み取る
    try:
        with zipfile.ZipFile(buf, "r") as zf:
            if "data.json" not in zf.namelist():
                return JSONResponse(status_code=400, content={"detail": "data.json が見つかりません"})
            data = json.loads(zf.read("data.json").decode("utf-8"))

            # uploads/ 内の画像ファイルを一時的にメモリに保持
            image_files: dict[str, bytes] = {}
            for name in zf.namelist():
                if name.startswith("uploads/") and not name.endswith("/"):
                    image_files[name] = zf.read(name)
    except zipfile.BadZipFile:
        return JSONResponse(status_code=400, content={"detail": "無効な ZIP ファイルです"})
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "バックアップの読み込みに失敗しました"})

    if "rooms" not in data:
        return JSONResponse(status_code=400, content={"detail": "バックアップ形式が正しくありません"})

    # --- 既存データ全削除 ---
    db.query(Assignment).delete()
    db.query(StaffAvailability).delete()
    db.query(StaffPreferredSession).delete()
    db.query(StaffSkill).delete()
    db.query(Staff).delete()
    db.query(LTTalk).delete()
    db.query(SessionModel).delete()
    db.query(SessionGroup).delete()
    db.query(Category).delete()
    db.query(VenueMap).delete()
    db.query(Room).delete()
    db.flush()

    # --- uploads ディレクトリをクリア＆画像ファイルを復元 ---
    if UPLOAD_DIR.exists():
        shutil.rmtree(UPLOAD_DIR)
    UPLOAD_DIR.mkdir(exist_ok=True)

    # ZIP 内のファイル名 → 新ファイル名のマッピング
    file_path_map: dict[str, str] = {}
    for zip_path, content in image_files.items():
        original_name = Path(zip_path).name
        ext = Path(original_name).suffix.lower()
        new_name = f"{uuid.uuid4().hex}{ext}"
        (UPLOAD_DIR / new_name).write_bytes(content)
        file_path_map[f"/uploads/{original_name}"] = f"/uploads/{new_name}"

    def _map_path(original: str) -> str:
        """バックアップ内のパスを復元後のパスに変換"""
        if not original:
            return ""
        return file_path_map.get(original, original)

    # ID マッピング (旧ID → 新ID)
    room_map = {}
    session_map = {}
    staff_map = {}
    group_map = {}

    # --- カテゴリ ---
    for c in data.get("categories", []):
        db.add(Category(key=c["key"], label=c["label"], color=c.get("color", "#1a73e8"), order=c.get("order", 0)))
    db.flush()

    # --- セッショングループ ---
    for g in data.get("session_groups", []):
        db_grp = SessionGroup(label=g["label"], date=g.get("date", ""), order=g.get("order", 0), color=g.get("color", "#1a73e8"))
        db.add(db_grp)
        db.flush()
        group_map[g["id"]] = db_grp.id

    # --- 部屋 ---
    for r in data.get("rooms", []):
        db_room = Room(name=r["name"], capacity=r["capacity"], floor=r.get("floor", 1))
        db.add(db_room)
        db.flush()
        room_map[r["id"]] = db_room.id

    # --- 会場地図 ---
    for v in data.get("venue_maps", []):
        db.add(VenueMap(
            title=v["title"], image=_map_path(v.get("image", "")), order=v.get("order", 0),
        ))

    # --- セッション ---
    for s in data.get("sessions", []):
        new_room_id = room_map.get(s["room_id"], s["room_id"])
        new_group_id = group_map.get(s.get("group_id")) if s.get("group_id") else None
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
            group_id=new_group_id,
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
                speaker_photo=_map_path(t.get("speaker_photo", "")),
                start_time=t.get("start_time", ""),
                end_time=t.get("end_time", ""),
                order=t.get("order", 0),
            ))

    # --- スタッフ ---
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

    # --- 配置 ---
    for a in data.get("assignments", []):
        new_sess_id = session_map.get(a["session_id"])
        new_staff_id = staff_map.get(a["staff_id"])
        if new_sess_id and new_staff_id:
            db.add(Assignment(
                session_id=new_sess_id, staff_id=new_staff_id, role=a.get("role", "support"),
            ))

    # --- 設定 ---
    for s in data.get("settings", []):
        existing = db.query(AppSetting).filter(AppSetting.key == s["key"]).first()
        if existing:
            existing.value = s["value"]
        else:
            db.add(AppSetting(key=s["key"], value=s["value"]))

    db.commit()

    return {
        "status": "ok",
        "rooms": len(room_map),
        "sessions": len(session_map),
        "staffs": len(staff_map),
        "assignments": len(data.get("assignments", [])),
    }


from ..models import AppSetting

RESET_PASSWORD_DEFAULT = os.environ.get("RESET_PASSWORD", "conf-reset-2026")


def _get_reset_password(db: Session) -> str:
    """DB設定 > 環境変数 > デフォルト の優先順で初期化パスワードを取得"""
    row = db.query(AppSetting).filter(AppSetting.key == "reset_password").first()
    if row and row.value:
        return row.value
    return RESET_PASSWORD_DEFAULT


class ResetRequest(BaseModel):
    password: str


@router.post("/reset")
def reset_all_data(body: ResetRequest, db: Session = Depends(get_db)):
    """全データを削除して初期化する（パスワード必須）"""
    if body.password != _get_reset_password(db):
        return JSONResponse(status_code=403, content={"detail": "パスワードが正しくありません"})

    db.query(Assignment).delete()
    db.query(StaffAvailability).delete()
    db.query(StaffPreferredSession).delete()
    db.query(StaffSkill).delete()
    db.query(Staff).delete()
    db.query(LTTalk).delete()
    db.query(SessionModel).delete()
    db.query(SessionGroup).delete()
    db.query(Category).delete()
    db.query(VenueMap).delete()
    db.query(Room).delete()
    db.flush()

    # uploads ディレクトリをクリア
    if UPLOAD_DIR.exists():
        shutil.rmtree(UPLOAD_DIR)
    UPLOAD_DIR.mkdir(exist_ok=True)

    db.commit()
    return {"status": "ok", "message": "全データを初期化しました"}


class ChangeResetPasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/reset-password")
def change_reset_password(body: ChangeResetPasswordRequest, db: Session = Depends(get_db)):
    """初期化パスワードを変更する"""
    if body.current_password != _get_reset_password(db):
        return JSONResponse(status_code=403, content={"detail": "現在のパスワードが正しくありません"})
    if not body.new_password:
        return JSONResponse(status_code=400, content={"detail": "新しいパスワードを入力してください"})
    row = db.query(AppSetting).filter(AppSetting.key == "reset_password").first()
    if row:
        row.value = body.new_password
    else:
        db.add(AppSetting(key="reset_password", value=body.new_password))
    db.commit()
    return {"status": "ok", "message": "初期化パスワードを変更しました"}
