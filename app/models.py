from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Table
from sqlalchemy.orm import relationship

from .database import Base

staff_skills = Table(
    "staff_skills",
    Base.metadata,
    Column("staff_id", Integer, ForeignKey("staffs.id"), primary_key=True),
    Column("skill", String, primary_key=True),
)


class VenueMap(Base):
    """会場全体の地図（フロアマップ等）"""
    __tablename__ = "venue_maps"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    image = Column(String, nullable=False)  # 画像パス
    order = Column(Integer, default=0)


class Room(Base):
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    capacity = Column(Integer, nullable=False)
    floor = Column(Integer, default=1)  # 階

    sessions = relationship("Session", back_populates="room")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    description = Column(String, default="")  # セッション説明
    notes = Column(String, default="")         # 備考
    speaker = Column(String, nullable=False)
    speaker_kana = Column(String, default="")
    speaker_photo = Column(String, default="")
    speaker_org = Column(String, default="")       # 所属
    speaker_title = Column(String, default="")     # 肩書き
    speaker_profile = Column(String, default="")   # プロフィール
    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime, nullable=False)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False)
    required_staff = Column(Integer, default=1)
    category = Column(String, default="general")
    english_required = Column(Integer, default=0)  # 英語対応スタッフ必要: 1, 不要: 0

    room = relationship("Room", back_populates="sessions")
    assignments = relationship("Assignment", back_populates="session")
    lt_talks = relationship("LTTalk", back_populates="session", cascade="all, delete-orphan", order_by="LTTalk.order")


class Staff(Base):
    __tablename__ = "staffs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    slack_name = Column(String, default="")
    photo = Column(String, default="")  # 顔写真パス
    english_ok = Column(Integer, default=0)  # 英語対応可: 1, 不可: 0
    role = Column(String, default="general")
    max_hours = Column(Integer, default=8)
    experience_count = Column(Integer, default=0)  # 参加回数（0=初めて）

    skills = relationship("StaffSkill", back_populates="staff", cascade="all, delete-orphan")
    preferred_sessions = relationship("StaffPreferredSession", back_populates="staff", cascade="all, delete-orphan")
    availabilities = relationship("StaffAvailability", back_populates="staff", cascade="all, delete-orphan")
    assignments = relationship("Assignment", back_populates="staff")


class StaffPreferredSession(Base):
    __tablename__ = "staff_preferred_sessions"

    id = Column(Integer, primary_key=True, index=True)
    staff_id = Column(Integer, ForeignKey("staffs.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    priority = Column(Integer, default=1)  # 1=最優先, 2=次点, ...

    staff = relationship("Staff", back_populates="preferred_sessions")
    session = relationship("Session")


class StaffAvailability(Base):
    __tablename__ = "staff_availabilities"

    id = Column(Integer, primary_key=True, index=True)
    staff_id = Column(Integer, ForeignKey("staffs.id"), nullable=False)
    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime, nullable=False)

    staff = relationship("Staff", back_populates="availabilities")


class StaffSkill(Base):
    __tablename__ = "staff_skills_v2"

    id = Column(Integer, primary_key=True, index=True)
    staff_id = Column(Integer, ForeignKey("staffs.id"), nullable=False)
    skill = Column(String, nullable=False)

    staff = relationship("Staff", back_populates="skills")


class LTTalk(Base):
    """ライトニングトークセッション内の個別トーク"""
    __tablename__ = "lt_talks"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    title = Column(String, nullable=False)
    speaker = Column(String, nullable=False)
    speaker_kana = Column(String, default="")
    speaker_org = Column(String, default="")
    speaker_title = Column(String, default="")
    speaker_photo = Column(String, default="")
    order = Column(Integer, default=0)

    session = relationship("Session", back_populates="lt_talks")


class AppSetting(Base):
    """アプリケーション設定 (key-value)"""
    __tablename__ = "app_settings"

    key = Column(String, primary_key=True)
    value = Column(String, nullable=False, default="")


class Assignment(Base):
    __tablename__ = "assignments"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    staff_id = Column(Integer, ForeignKey("staffs.id"), nullable=False)
    role = Column(String, default="support")

    session = relationship("Session", back_populates="assignments")
    staff = relationship("Staff", back_populates="assignments")
