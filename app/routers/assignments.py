from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..models import Session as SessionModel, Staff, Assignment, StaffSkill, StaffPreferredSession, StaffAvailability, Category
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


def _is_available(staff: Staff, session: SessionModel) -> bool:
    """スタッフの活動可能時間内にセッションが収まるかチェック"""
    if not staff.availabilities:
        return True  # 活動可能時間が未設定なら制約なし
    for avail in staff.availabilities:
        if avail.start_time <= session.start_time and avail.end_time >= session.end_time:
            return True
    return False


def _preference_score(staff: Staff, session_id: int) -> int:
    """希望セッションに対するスコアを返す (高いほど優先)"""
    for pref in staff.preferred_sessions:
        if pref.session_id == session_id:
            return max(0, 100 - (pref.priority - 1) * 20)  # priority 1=100, 2=80, 3=60...
    return 0

router = APIRouter(prefix="/api/assignments", tags=["assignments"])


@router.get("/schedule", response_model=ScheduleResponse)
def get_full_schedule(db: Session = Depends(get_db)):
    """セッション一覧と各セッションに割り当てられたスタッフを返す"""
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
            joinedload(Staff.skills),
            joinedload(Staff.assignments).joinedload(Assignment.session).joinedload(SessionModel.room),
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


@router.post("/auto-assign")
def auto_assign_staff(body: AutoAssignRequest | None = None, db: Session = Depends(get_db)):
    """スケジュールに基づいてスタッフを自動配置する

    session_ids が指定された場合、そのセッションのみ再配置する（他は維持）。
    空の場合は全セッションを再配置する。
    """
    target_ids = set(body.session_ids) if body and body.session_ids else set()

    if target_ids:
        # 対象セッションの割り当てのみクリア
        db.query(Assignment).filter(Assignment.session_id.in_(target_ids)).delete(synchronize_session='fetch')
    else:
        # 全クリア
        db.query(Assignment).delete()
    db.flush()

    # 動的カテゴリキーを取得（受付案内・懇親会などカスタムカテゴリ）
    dynamic_cat_keys = {c.key for c in db.query(Category.key).all()}

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

    # 部分再配置の場合、既存割り当てを事前にロード
    if target_ids:
        existing = db.query(Assignment).all()
        sessions_by_id = {s.id: s for s in sessions}
        for a in existing:
            if a.session_id in sessions_by_id:
                sess = sessions_by_id[a.session_id]
                staff_sessions[a.staff_id].append(sess)
                dur = (sess.end_time - sess.start_time).total_seconds() / 3600
                staff_hours[a.staff_id] += dur

    def _is_effectively_experienced(staff) -> bool:
        """経験者 or 既に1セッション経験者と組んで担当済みの初回スタッフ"""
        if staff.experience_count > 0:
            return True
        return staff.id in newcomer_trained

    results = []

    for session in sessions:
        # 部分再配置: 対象外セッションはスキップ
        if target_ids and session.id not in target_ids:
            continue

        session_duration = (session.end_time - session.start_time).total_seconds() / 3600
        effective_required = max(2, session.required_staff)
        assigned_count = 0

        # セッションカテゴリに対応するスタッフロールを判定
        session_role = session.category if session.category in dynamic_cat_keys else 'session'

        # 全体スケジュールは全員配置（ロール・時間制約をスキップ）
        if session.category == 'overall':
            for staff in staffs:
                # 時間帯の重複チェックのみ行う
                can = True
                for assigned_session in staff_sessions[staff.id]:
                    if session.start_time < assigned_session.end_time and session.end_time > assigned_session.start_time:
                        can = False
                        break
                if not can:
                    continue
                assignment = Assignment(session_id=session.id, staff_id=staff.id, role='overall')
                db.add(assignment)
                staff_sessions[staff.id].append(session)
                staff_hours[staff.id] += session_duration
                assigned_count += 1
            results.append({
                "session_id": session.id,
                "session_title": session.title,
                "required": len(staffs),
                "assigned": assigned_count,
            })
            continue

        # スタッフをスコアリング
        scored_staffs = []
        for staff in staffs:
            # ロールフィルタ: スタッフの担当ロール（カンマ区切り）にセッションロールが含まれるか
            staff_roles = [r for r in (staff.role or "").split(",") if r]
            if session_role not in staff_roles:
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
            # 担当件数均等化: 担当が少ないスタッフを優先（1件あたり-5点）
            score -= len(staff_sessions[staff.id]) * 5
            # 階移動ペナルティ: 直前セッションと階が違うほど減点
            prev_sessions = staff_sessions[staff.id]
            if prev_sessions and session.room:
                # 直前に終了したセッション（このセッション開始前で最も遅く終わるもの）
                prev = max(
                    (s for s in prev_sessions if s.end_time <= session.start_time),
                    key=lambda s: s.end_time,
                    default=None,
                )
                if prev and prev.room and session.room:
                    floor_diff = abs(session.room.floor - prev.room.floor)
                    score -= floor_diff * 3  # 1階差あたり-3点
            scored_staffs.append((score, staff))

        scored_staffs.sort(key=lambda x: -x[0])

        def _can_assign(staff):
            if staff_hours[staff.id] + session_duration > staff.max_hours:
                return False
            for assigned_session in staff_sessions[staff.id]:
                if session.start_time < assigned_session.end_time and session.end_time > assigned_session.start_time:
                    return False
            return True

        # 未経験の初心者がいる場合、経験者を優先的に1人確保
        has_raw_newcomer = any(
            not _is_effectively_experienced(s) and _can_assign(s)
            for _, s in scored_staffs
        )
        assigned_this = []
        if effective_required >= 2 and has_raw_newcomer:
            for _score, staff in scored_staffs:
                if _is_effectively_experienced(staff) and _can_assign(staff):
                    assignment = Assignment(session_id=session.id, staff_id=staff.id, role=session_role)
                    db.add(assignment)
                    staff_sessions[staff.id].append(session)
                    staff_hours[staff.id] += session_duration
                    assigned_count += 1
                    assigned_this.append(staff.id)
                    break

        for _score, staff in scored_staffs:
            if assigned_count >= effective_required:
                break
            if staff.id in assigned_this:
                continue
            if not _can_assign(staff):
                continue

            # 割り当て
            assignment = Assignment(session_id=session.id, staff_id=staff.id, role=session_role)
            db.add(assignment)
            staff_sessions[staff.id].append(session)
            staff_hours[staff.id] += session_duration
            assigned_count += 1

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
        db.add(Assignment(session_id=from_session_id, staff_id=to_staff_id, role=staffs_by_id[to_staff_id].role))
        db.add(Assignment(session_id=to_session_id, staff_id=from_staff_id, role=staffs_by_id[from_staff_id].role))
        staff_sessions[from_staff_id] = [s for s in staff_sessions[from_staff_id] if s.id != from_session_id]
        staff_sessions[to_staff_id] = [s for s in staff_sessions[to_staff_id] if s.id != to_session_id]
        from_sess = next(s for s in sessions if s.id == from_session_id)
        to_sess = next(s for s in sessions if s.id == to_session_id)
        staff_sessions[to_staff_id].append(from_sess)
        staff_sessions[from_staff_id].append(to_sess)
        staff_hours[from_staff_id] += dur_to - dur_from
        staff_hours[to_staff_id] += dur_from - dur_to

    staffs_by_id = {s.id: s for s in staffs}

    def _has_time_conflict(staff_id, target_session, exclude_session_id):
        for assigned_sess in staff_sessions[staff_id]:
            if assigned_sess.id == exclude_session_id:
                continue
            if target_session.start_time < assigned_sess.end_time and target_session.end_time > assigned_sess.start_time:
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
            joinedload(Assignment.session).joinedload(SessionModel.room),
            joinedload(Assignment.staff).joinedload(Staff.skills),
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

    # 時間重複チェック: このスタッフが既に割り当てられているセッションと時間が被らないか
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
