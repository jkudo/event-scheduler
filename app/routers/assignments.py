import json
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload, selectinload

from ..database import get_db
from ..models import Session as SessionModel, Staff, Assignment, StaffSkill, StaffPreferredSession, StaffAvailability, Category, AppSetting
from ..schemas import (
    AssignmentCreate,
    AssignmentResponse,
    AssignedStaffEntry,
    ScheduleResponse,
    ScheduleEntry,
    StaffScheduleResponse,
    StaffScheduleEntry,
    SessionResponse,
    StaffResponse,
)
from ..utils import is_staff_available as _is_available

DEFAULT_TRAVEL_MINUTES = 10  # 別部屋間の移動に必要な最低時間（設定で変更可）
LOAD_COUNT_PENALTY = 8   # 負荷均等化: 担当1件あたりの減点
LOAD_HOURS_PENALTY = 12  # 負荷均等化: 累計担当1時間あたりの減点
UNASSIGNED_BONUS = 30    # まだ1件も担当していないスタッフへの加点


def _get_travel_buffer(db: Session) -> timedelta:
    """設定された別部屋間の移動時間（分）を timedelta で返す"""
    row = db.query(AppSetting).filter(AppSetting.key == "travel_buffer_minutes").first()
    try:
        minutes = int(row.value) if row and row.value else DEFAULT_TRAVEL_MINUTES
    except (ValueError, TypeError):
        minutes = DEFAULT_TRAVEL_MINUTES
    return timedelta(minutes=max(0, minutes))


def _preference_score(staff: Staff, session_id: int) -> int:
    """希望セッションに対するスコアを返す (高いほど優先)"""
    for pref in staff.preferred_sessions:
        if pref.session_id == session_id:
            return max(0, 100 - (pref.priority - 1) * 20)  # priority 1=100, 2=80, 3=60...
    return 0


def _load_role_links(db: Session, setting_key: str) -> dict:
    """追加で紐づけられた担当キーの辞書を返す {カテゴリキーまたはグループID: [担当キー, ...]}"""
    row = db.query(AppSetting).filter(AppSetting.key == setting_key).first()
    try:
        links = json.loads(row.value) if row and row.value else {}
    except ValueError:
        links = {}
    return links if isinstance(links, dict) else {}

router = APIRouter(prefix="/api/assignments", tags=["assignments"])


@router.get("/schedule", response_model=ScheduleResponse)
def get_full_schedule(db: Session = Depends(get_db)):
    """セッション一覧と各セッションに割り当てられたスタッフを返す"""
    sessions = (
        db.query(SessionModel)
        .options(
            joinedload(SessionModel.room),
            selectinload(SessionModel.lt_talks),
            selectinload(SessionModel.assignments).joinedload(Assignment.staff),
        )
        .order_by(SessionModel.start_time)
        .all()
    )
    entries = []
    for s in sessions:
        assigned = [AssignedStaffEntry(assignment_id=a.id, staff=a.staff) for a in s.assignments]
        entries.append(ScheduleEntry(session=s, assigned_staff=assigned))
    return ScheduleResponse(schedule=entries)


@router.get("/staff-schedule", response_model=StaffScheduleResponse)
def get_staff_schedule(db: Session = Depends(get_db)):
    """スタッフごとの担当セッション一覧を返す"""
    staffs = (
        db.query(Staff)
        .options(
            selectinload(Staff.availabilities),
            selectinload(Staff.assignments)
            .joinedload(Assignment.session)
            .options(joinedload(SessionModel.room), selectinload(SessionModel.lt_talks)),
        )
        .all()
    )
    entries = []
    for st in staffs:
        assigned_sessions = sorted([a.session for a in st.assignments], key=lambda s: s.start_time)
        entries.append(StaffScheduleEntry(staff=st, assigned_sessions=assigned_sessions))
    return StaffScheduleResponse(staff_assignments=entries)


class AutoAssignRequest(BaseModel):
    session_ids: list[int] = []
    fill_only: bool = False


@router.post("/auto-assign")
def auto_assign_staff(body: AutoAssignRequest | None = None, db: Session = Depends(get_db)):
    """スケジュールに基づいてスタッフを自動配置する

    session_ids が指定された場合、そのセッションのみ再配置する（他は維持）。
    空の場合は全セッションを再配置する。
    fill_only の場合、既存配置を維持したまま不足分のみ追加配置する。
    """
    target_ids = set(body.session_ids) if body and body.session_ids else set()
    fill_only = bool(body and body.fill_only)

    if fill_only:
        pass  # 既存配置を維持
    elif target_ids:
        # 対象セッションの割り当てのみクリア
        db.query(Assignment).filter(Assignment.session_id.in_(target_ids)).delete(synchronize_session='fetch')
    else:
        # 全クリア
        db.query(Assignment).delete()
    db.flush()

    # 動的カテゴリキーを取得（受付案内・懇親会などカスタムカテゴリ）
    dynamic_cat_keys = {c.key for c in db.query(Category.key).all()}
    category_role_links = _load_role_links(db, "category_role_links")
    group_role_links = _load_role_links(db, "group_role_links")
    travel_buffer = _get_travel_buffer(db)

    sessions = db.query(SessionModel).options(joinedload(SessionModel.room)).order_by(SessionModel.start_time).all()
    staffs = (
        db.query(Staff)
        .options(
            joinedload(Staff.skills),
            joinedload(Staff.preferred_sessions),
            joinedload(Staff.availabilities),
        )
        .all()
    )

    # スタッフごとの割り当て済みセッションと合計時間を追跡
    staff_sessions: dict[int, list[SessionModel]] = {s.id: [] for s in staffs}
    staff_hours: dict[int, float] = {s.id: 0.0 for s in staffs}
    # 初回スタッフが経験者と一緒に1セッション担当済みかどうか
    newcomer_trained: set[int] = set()
    # スタッフペアの共演回数（同じペアの繰り返しを避けるため）
    pair_count: dict[tuple[int, int], int] = {}

    def _bump_pairs(staff_ids):
        for i in range(len(staff_ids)):
            for j in range(i + 1, len(staff_ids)):
                a, b = staff_ids[i], staff_ids[j]
                key = (a, b) if a < b else (b, a)
                pair_count[key] = pair_count.get(key, 0) + 1

    # このリクエストで（再）配置される対象セッション
    processed_ids = set(target_ids) if target_ids else {s.id for s in sessions}

    # 部分再配置・不足分配置の場合、既存割り当てを事前にロード
    if target_ids or fill_only:
        existing = db.query(Assignment).all()
        sessions_by_id = {s.id: s for s in sessions}
        seed_pairs: dict[int, list[int]] = {}
        for a in existing:
            if a.session_id in sessions_by_id:
                sess = sessions_by_id[a.session_id]
                staff_sessions[a.staff_id].append(sess)
                dur = (sess.end_time - sess.start_time).total_seconds() / 3600
                staff_hours[a.staff_id] += dur
                # 維持されるセッション（再配置対象外）のペアのみ先行カウント
                if a.session_id not in processed_ids:
                    seed_pairs.setdefault(a.session_id, []).append(a.staff_id)
        for sids in seed_pairs.values():
            _bump_pairs(sids)

    def _is_effectively_experienced(staff) -> bool:
        """経験者 or 既に1セッション経験者と組んで担当済みの初回スタッフ"""
        if staff.experience_count > 0:
            return True
        return staff.id in newcomer_trained

    sessions_by_id_all = {s.id: s for s in sessions}

    def _session_roles(sess):
        """セッションに対応する担当ロールと、配置対象となる全ロールを返す"""
        session_role = sess.category if sess.category in dynamic_cat_keys else 'session'
        roles = {session_role, *category_role_links.get(session_role, [])}
        if sess.group_id:
            roles |= set(group_role_links.get(str(sess.group_id), []))
        return session_role, roles

    def _fits(staff, sess) -> bool:
        """稼働上限・時間重複・別部屋への移動時間を満たすか"""
        duration = (sess.end_time - sess.start_time).total_seconds() / 3600
        if staff_hours[staff.id] + duration > staff.max_hours:
            return False
        for assigned in staff_sessions[staff.id]:
            # 時間重複は不可
            if sess.start_time < assigned.end_time and sess.end_time > assigned.start_time:
                return False
            # 別部屋への移動には設定された移動時間が必要
            if assigned.room_id != sess.room_id:
                if assigned.end_time <= sess.start_time:
                    gap = sess.start_time - assigned.end_time
                else:
                    gap = assigned.start_time - sess.end_time
                if gap < travel_buffer:
                    return False
        return True

    def _auto_target(sess) -> bool:
        """自動配置の対象セッションか（対象外指定・全員・必要0・全体を除く）"""
        if sess is None:
            return False
        if target_ids and sess.id not in target_ids:
            return False
        if sess.required_staff in (-1, 0) or sess.category == 'overall':
            return False
        return True

    def _reserve_preferred() -> set[int]:
        """希望セッションを先に確保する

        本配置は開始時刻順に処理するため、先に処理されたセッションが希望者を
        取ってしまい、希望していたセッションが未配置になることがある。
        これを防ぐため、優先度の高い希望から順に、1人あたり1件だけ先行して押さえる。
        """
        reserved: set[int] = set()
        prefs_by_staff: dict[int, list] = {}
        max_priority = 0
        for staff in staffs:
            plist = sorted(staff.preferred_sessions, key=lambda p: p.priority)
            if plist:
                prefs_by_staff[staff.id] = plist
                max_priority = max(max_priority, plist[-1].priority)
        if not prefs_by_staff:
            return reserved

        staff_by_id = {s.id: s for s in staffs}
        # 同じ優先度で競合した場合は希望件数が少ないスタッフを優先（他の選択肢が少ないため）
        order = sorted(prefs_by_staff, key=lambda sid: (len(prefs_by_staff[sid]), sid))

        for priority in range(1, max_priority + 1):
            for sid in order:
                if sid in reserved:
                    continue
                staff = staff_by_id[sid]
                pref = next((p for p in prefs_by_staff[sid] if p.priority == priority), None)
                if pref is None:
                    continue
                sess = sessions_by_id_all.get(pref.session_id)
                if not _auto_target(sess):
                    continue
                # 既にそのセッションへ配置済み（部分再配置・不足分配置）なら確保済み扱い
                if sess in staff_sessions[sid]:
                    reserved.add(sid)
                    continue
                # 必要人数に空きがあるか。
                # 未経験者で埋め切ると本配置の「経験者を1名確保する」処理
                # （assigned_count < effective_required の条件）が走らなくなり、
                # 初心者だけのセッションが生まれるため、未経験者には最後の1枠を残す。
                filled = sum(1 for st in staffs if sess in staff_sessions[st.id])
                capacity = sess.required_staff
                if sess.required_staff >= 2 and not _is_effectively_experienced(staff):
                    already_exp = any(
                        _is_effectively_experienced(st) for st in staffs if sess in staff_sessions[st.id]
                    )
                    if not already_exp:
                        capacity -= 1
                if filled >= capacity:
                    continue
                session_role, allowed_roles = _session_roles(sess)
                staff_roles = [r for r in (staff.role or "").split(",") if r]
                if not allowed_roles & set(staff_roles):
                    continue
                if not _is_available(staff, sess):
                    continue
                if not _fits(staff, sess):
                    continue
                db.add(Assignment(session_id=sess.id, staff_id=sid, role=session_role))
                staff_sessions[sid].append(sess)
                staff_hours[sid] += (sess.end_time - sess.start_time).total_seconds() / 3600
                reserved.add(sid)
        return reserved

    _reserve_preferred()

    results = []

    for session in sessions:
        # 部分再配置: 対象外セッションはスキップ
        if target_ids and session.id not in target_ids:
            continue

        session_duration = (session.end_time - session.start_time).total_seconds() / 3600
        # 設定された必要人数どおりに配置（1なら1名）。0/-1/overallは前段でスキップ済み
        effective_required = session.required_staff
        # 既存配置（不足分配置）と希望の先行確保を起点に、不足分のみ追加する
        assigned_count = sum(1 for st in staffs if session in staff_sessions[st.id])

        # セッションカテゴリに対応するスタッフロールを判定（カテゴリ・グループに紐づけた担当も配置対象）
        session_role, allowed_roles = _session_roles(session)

        # 「全員」設定（-1）・必要人数0・overallは自動配置をスキップ
        if session.required_staff in (-1, 0) or session.category == 'overall':
            results.append({
                "session_id": session.id,
                "session_title": session.title,
                "required": 0,
                "assigned": 0,
            })
            continue

        # スタッフをスコアリング（スタッフ自身の履歴に依存する項目）
        REST_GAP = timedelta(minutes=30)  # この時間内に前担当が終わっていれば「連続」扱い
        base_map: dict[int, float] = {}
        candidates = []
        for staff in staffs:
            # ロールフィルタ: スタッフの担当ロール（カンマ区切り）が配置対象ロールと一致するか
            staff_roles = [r for r in (staff.role or "").split(",") if r]
            if not allowed_roles & set(staff_roles):
                continue
            # 活動可能時間チェック (必須)
            if not _is_available(staff, session):
                continue

            score = 0
            # 希望セッションスコア (最大100)
            score += _preference_score(staff, session.id)
            # スキルマッチスコア
            skill_names = [sk.skill for sk in staff.skills]
            if session.category in skill_names:
                score += 10
            if session_role in staff_roles:
                score += 5
            # 英語対応: 英語必要セッションでは英語対応スタッフを優先
            if session.english_required and staff.english_ok:
                score += 50
            # 負荷均等化: 担当件数と累計担当時間の両方で減点
            score -= len(staff_sessions[staff.id]) * LOAD_COUNT_PENALTY
            score -= staff_hours[staff.id] * LOAD_HOURS_PENALTY
            # 未配置スタッフを優先（全員に担当が行き渡るようにする）
            if not staff_sessions[staff.id]:
                score += UNASSIGNED_BONUS

            prev_sessions = staff_sessions[staff.id]
            # このセッション開始前のセッションを新しい順に
            before = sorted(
                (s for s in prev_sessions if s.end_time <= session.start_time),
                key=lambda s: s.end_time, reverse=True,
            )
            # 階移動ペナルティ: 直前セッションと階が違うほど減点
            if before and before[0].room and session.room:
                floor_diff = abs(session.room.floor - before[0].room.floor)
                score -= floor_diff * 3  # 1階差あたり-3点
            # 連続配置ペナルティ: 直前の担当が休憩なく続く
            for s in prev_sessions:
                gap = session.start_time - s.end_time
                if timedelta(0) <= gap < REST_GAP:
                    score -= 40
                    break
            # 同部屋連続ペナルティ: 直近2セッションに同じ部屋があれば減点（一回休みを挟んでも）
            if session.room and any(s.room_id == session.room_id for s in before[:2]):
                score -= 25

            base_map[staff.id] = score
            candidates.append(staff)

        def _can_assign(staff):
            return _fits(staff, session)

        # このセッションに既に配置済みのスタッフ（fill_onlyの既存配置含む）
        current_ids = [st.id for st in staffs if session in staff_sessions[st.id]]

        def _pair_pen(staff):
            # 既に同席が多いスタッフとの組み合わせほど減点
            pen = 0
            for oid in current_ids:
                key = (staff.id, oid) if staff.id < oid else (oid, staff.id)
                pen += pair_count.get(key, 0) * 15
            return pen

        def _pick_best(experienced_only=False):
            best, best_key = None, None
            for staff in candidates:
                if staff.id in current_ids:
                    continue
                if experienced_only and not _is_effectively_experienced(staff):
                    continue
                if not _can_assign(staff):
                    continue
                eff = base_map[staff.id] - _pair_pen(staff)
                # 同点時は担当件数・担当時間が少ないスタッフを優先（最後にIDで安定化）
                key = (eff, -len(staff_sessions[staff.id]), -staff_hours[staff.id], -staff.id)
                if best_key is None or key > best_key:
                    best, best_key = staff, key
            return best

        def _do_assign(staff):
            db.add(Assignment(session_id=session.id, staff_id=staff.id, role=session_role))
            staff_sessions[staff.id].append(session)
            staff_hours[staff.id] += session_duration
            current_ids.append(staff.id)

        # 既存配置（fill_only等）に経験者がいるかどうか
        already_has_experienced = any(
            _is_effectively_experienced(s) for s in staffs if s.id in current_ids
        )
        # 未経験の初心者がいて経験者が未確保の場合、経験者を優先的に1人確保
        if effective_required >= 2 and assigned_count < effective_required and not already_has_experienced:
            has_raw_newcomer = any(
                (not _is_effectively_experienced(s)) and (s.id not in current_ids) and _can_assign(s)
                for s in candidates
            )
            if has_raw_newcomer:
                pick = _pick_best(experienced_only=True)
                if pick:
                    _do_assign(pick)
                    assigned_count += 1

        # 残りをペア回避を考慮して1人ずつ選出
        while assigned_count < effective_required:
            pick = _pick_best()
            if pick is None:
                break
            _do_assign(pick)
            assigned_count += 1

        # このセッションの最終ペアを記録
        _bump_pairs(current_ids)

        # このセッションに配置されたスタッフを特定し、経験者と組んだ初心者をtrained扱いにする
        assigned_staff_ids = [s.id for s in staffs if session in staff_sessions[s.id]]
        has_exp = any(_is_effectively_experienced(s) for s in staffs if s.id in assigned_staff_ids)
        if has_exp:
            for sid in assigned_staff_ids:
                s = next(s for s in staffs if s.id == sid)
                if s.experience_count == 0:
                    newcomer_trained.add(sid)

        results.append({
            "session_id": session.id,
            "session_title": session.title,
            "required": effective_required,
            "assigned": assigned_count,
        })

    db.flush()

    # === 初心者制約: 未経験の初心者だけのセッションを解消 ===
    # (newcomer_trainedに入っている初心者は経験者扱い)
    session_staff_map: dict[int, list[Staff]] = {}
    for staff in staffs:
        for sess in staff_sessions[staff.id]:
            session_staff_map.setdefault(sess.id, []).append(staff)

    def _swap_assignment(from_session_id, from_staff_id, to_session_id, to_staff_id, dur_from, dur_to):
        """2つのセッション間でスタッフを入れ替える"""
        db.query(Assignment).filter(
            Assignment.session_id == from_session_id, Assignment.staff_id == from_staff_id
        ).delete()
        db.query(Assignment).filter(
            Assignment.session_id == to_session_id, Assignment.staff_id == to_staff_id
        ).delete()
        from_sess = next(s for s in sessions if s.id == from_session_id)
        to_sess = next(s for s in sessions if s.id == to_session_id)
        db.add(Assignment(session_id=from_session_id, staff_id=to_staff_id, role=from_sess.category or "support"))
        db.add(Assignment(session_id=to_session_id, staff_id=from_staff_id, role=to_sess.category or "support"))
        staff_sessions[from_staff_id] = [s for s in staff_sessions[from_staff_id] if s.id != from_session_id]
        staff_sessions[to_staff_id] = [s for s in staff_sessions[to_staff_id] if s.id != to_session_id]
        staff_sessions[to_staff_id].append(from_sess)
        staff_sessions[from_staff_id].append(to_sess)
        staff_hours[from_staff_id] += dur_to - dur_from
        staff_hours[to_staff_id] += dur_from - dur_to

    staffs_by_id = {s.id: s for s in staffs}

    def _has_time_conflict(staff_id, target_session, exclude_session_id):
        for assigned_sess in staff_sessions[staff_id]:
            if assigned_sess.id == exclude_session_id:
                continue
            # 時間重複
            if target_session.start_time < assigned_sess.end_time and target_session.end_time > assigned_sess.start_time:
                return True
            # 別部屋への移動時間を確保
            if assigned_sess.room_id != target_session.room_id:
                if assigned_sess.end_time <= target_session.start_time:
                    gap = target_session.start_time - assigned_sess.end_time
                else:
                    gap = assigned_sess.start_time - target_session.end_time
                if gap < travel_buffer:
                    return True
        return False

    for session in sessions:
        assigned_list = session_staff_map.get(session.id, [])
        if len(assigned_list) <= 1:
            continue

        experienced = [s for s in assigned_list if _is_effectively_experienced(s)]
        raw_newcomers = [s for s in assigned_list if not _is_effectively_experienced(s)]

        if not raw_newcomers or experienced:
            continue  # 経験者(or trained済み)がいるか、未経験初心者がいなければOK

        # 全員が未経験初心者 → 同時間帯の他セッションの経験者とスワップ
        session_duration = (session.end_time - session.start_time).total_seconds() / 3600
        swapped = False

        for newcomer in raw_newcomers:
            for other_sess in sessions:
                if other_sess.id == session.id:
                    continue
                if not (session.start_time < other_sess.end_time and session.end_time > other_sess.start_time):
                    continue
                other_staff = session_staff_map.get(other_sess.id, [])
                other_exp = [s for s in other_staff if _is_effectively_experienced(s)]
                other_raw = [s for s in other_staff if not _is_effectively_experienced(s)]

                for exp_staff in other_exp:
                    if len(other_exp) <= 1 and other_raw:
                        continue

                    if not _is_available(exp_staff, session):
                        continue
                    if not _is_available(newcomer, other_sess):
                        continue
                    if _has_time_conflict(exp_staff.id, session, other_sess.id):
                        continue
                    if _has_time_conflict(newcomer.id, other_sess, session.id):
                        continue

                    other_dur = (other_sess.end_time - other_sess.start_time).total_seconds() / 3600
                    if staff_hours[exp_staff.id] - other_dur + session_duration > exp_staff.max_hours:
                        continue
                    if staff_hours[newcomer.id] - session_duration + other_dur > newcomer.max_hours:
                        continue

                    _swap_assignment(session.id, newcomer.id, other_sess.id, exp_staff.id, session_duration, other_dur)
                    session_staff_map[session.id] = [s for s in session_staff_map[session.id] if s.id != newcomer.id] + [exp_staff]
                    session_staff_map[other_sess.id] = [s for s in session_staff_map[other_sess.id] if s.id != exp_staff.id] + [newcomer]
                    swapped = True
                    break
                if swapped:
                    break
            if swapped:
                break

    db.commit()

    unassigned = [r for r in results if r["assigned"] < r["required"]]
    return {
        "message": "Auto-assignment completed",
        "total_sessions": len(results),
        "fully_assigned": len(results) - len(unassigned),
        "understaffed": unassigned,
    }


@router.get("/", response_model=list[AssignmentResponse])
def list_assignments(db: Session = Depends(get_db)):
    return (
        db.query(Assignment)
        .options(
            joinedload(Assignment.session).options(
                joinedload(SessionModel.room), selectinload(SessionModel.lt_talks)
            ),
            joinedload(Assignment.staff).options(
                selectinload(Staff.skills),
                selectinload(Staff.preferred_sessions),
                selectinload(Staff.availabilities),
            ),
        )
        .all()
    )


@router.post("/", response_model=AssignmentResponse, status_code=201)
def create_assignment(data: AssignmentCreate, db: Session = Depends(get_db)):
    """手動でスタッフをセッションに割り当てる（時間重複を厳格にチェック）"""
    session = db.query(SessionModel).filter(SessionModel.id == data.session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    staff = db.query(Staff).filter(Staff.id == data.staff_id).first()
    if not staff:
        raise HTTPException(status_code=404, detail="Staff not found")
    existing = db.query(Assignment).filter(
        Assignment.session_id == data.session_id, Assignment.staff_id == data.staff_id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Already assigned")

    # ロール検証（全体スケジュールは全スタッフ配置可、カテゴリ・グループに紐づけた担当も配置対象）
    if session.category != "overall":
        dynamic_cat_keys = {c.key for c in db.query(Category.key).all()}
        required_role = session.category if session.category in dynamic_cat_keys else "session"
        allowed_roles = {required_role, *_load_role_links(db, "category_role_links").get(required_role, [])}
        if session.group_id:
            allowed_roles |= set(_load_role_links(db, "group_role_links").get(str(session.group_id), []))
        staff_roles = [r for r in (staff.role or "").split(",") if r]
        if not allowed_roles & set(staff_roles):
            cat_row = db.query(Category).filter(Category.key == required_role).first()
            role_label = cat_row.label if cat_row else "セッション"
            raise HTTPException(
                status_code=400,
                detail=f"{staff.name} の担当は「{role_label}」に配置できません",
            )

    # 時間重複チェック（allow_overlap設定で無効化可能）
    allow_overlap = db.query(AppSetting).filter(AppSetting.key == "allow_overlap").first()
    if not (allow_overlap and allow_overlap.value == "1"):
        travel_buffer = _get_travel_buffer(db)
        travel_min = int(travel_buffer.total_seconds() // 60)
        staff_assignments = (
            db.query(Assignment)
            .options(joinedload(Assignment.session))
            .filter(Assignment.staff_id == data.staff_id)
            .all()
        )
        for a in staff_assignments:
            other = a.session
            if session.start_time < other.end_time and session.end_time > other.start_time:
                raise HTTPException(
                    status_code=400,
                    detail=f"時間が重複しています: {staff.name} は {other.title}（{other.start_time.strftime('%H:%M')}-{other.end_time.strftime('%H:%M')}）に配置済みです",
                )
            # 別部屋への移動時間を確保
            if travel_buffer and other.room_id != session.room_id:
                gap = (session.start_time - other.end_time) if other.end_time <= session.start_time else (other.start_time - session.end_time)
                if gap < travel_buffer:
                    raise HTTPException(
                        status_code=400,
                        detail=f"移動時間が不足しています: {staff.name} は別部屋の {other.title}（{other.start_time.strftime('%H:%M')}-{other.end_time.strftime('%H:%M')}）と{travel_min}分未満の間隔です",
                    )

    assignment = Assignment(session_id=data.session_id, staff_id=data.staff_id, role=data.role)
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return db.query(Assignment).options(
        joinedload(Assignment.session).joinedload(SessionModel.room),
        joinedload(Assignment.staff).joinedload(Staff.skills),
    ).filter(Assignment.id == assignment.id).first()


@router.delete("/{assignment_id}", status_code=204)
def delete_assignment(assignment_id: int, db: Session = Depends(get_db)):
    """個別の割り当てを削除する"""
    assignment = db.query(Assignment).filter(Assignment.id == assignment_id).first()
    if not assignment:
        raise HTTPException(status_code=404, detail="Assignment not found")
    db.delete(assignment)
    db.commit()


@router.delete("/", status_code=204)
def clear_assignments(db: Session = Depends(get_db)):
    db.query(Assignment).delete()
    db.commit()
