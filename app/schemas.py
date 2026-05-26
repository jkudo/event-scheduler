from datetime import datetime
from pydantic import BaseModel, field_validator, model_validator


# --- SessionGroup ---
class SessionGroupCreate(BaseModel):
    label: str
    date: str = ""
    order: int = 0
    color: str = "#1a73e8"


class SessionGroupResponse(BaseModel):
    id: int
    label: str
    date: str
    order: int
    color: str

    model_config = {"from_attributes": True}


# --- Category ---
class CategoryCreate(BaseModel):
    key: str | None = None
    label: str
    color: str = "#607d8b"
    order: int = 0


class CategoryResponse(BaseModel):
    id: int
    key: str
    label: str
    color: str
    order: int

    model_config = {"from_attributes": True}


# --- VenueMap ---
class VenueMapResponse(BaseModel):
    id: int
    title: str
    image: str
    order: int

    model_config = {"from_attributes": True}


# --- Room ---
class RoomCreate(BaseModel):
    name: str
    capacity: int
    floor: int = 1


class RoomResponse(BaseModel):
    id: int
    name: str
    capacity: int
    floor: int

    model_config = {"from_attributes": True}


# --- Session ---
class SessionCreate(BaseModel):
    title: str
    description: str = ""
    notes: str = ""
    speaker: str
    speaker_kana: str = ""
    speaker_photo: str = ""
    speaker_org: str = ""
    speaker_title: str = ""
    speaker_profile: str = ""
    start_time: datetime
    end_time: datetime
    room_id: int
    required_staff: int = 0
    category: str = "general"
    english_required: bool = False
    group_id: int | None = None


class SessionResponse(BaseModel):
    id: int
    title: str
    description: str
    notes: str
    speaker: str
    speaker_kana: str
    speaker_photo: str
    speaker_org: str
    speaker_title: str
    speaker_profile: str
    start_time: datetime
    end_time: datetime
    room_id: int
    required_staff: int
    category: str
    english_required: bool
    group_id: int | None = None
    room: RoomResponse | None = None
    lt_talks: list["LTTalkResponse"] = []

    model_config = {"from_attributes": True}


# --- LT Talk ---
class LTTalkCreate(BaseModel):
    title: str
    speaker: str
    speaker_kana: str = ""
    speaker_org: str = ""
    speaker_title: str = ""
    speaker_photo: str = ""
    start_time: str = ""
    end_time: str = ""
    order: int = 0
    is_representative: int = 0


class LTTalkResponse(BaseModel):
    id: int
    session_id: int
    title: str
    speaker: str
    speaker_kana: str
    speaker_org: str
    speaker_title: str
    speaker_photo: str
    start_time: str
    end_time: str
    order: int
    is_representative: int = 0

    model_config = {"from_attributes": True}

    @field_validator("is_representative", mode="before")
    @classmethod
    def _default_is_representative(cls, v):
        return v if v is not None else 0


# --- Staff ---
class StaffSkillResponse(BaseModel):
    id: int
    skill: str

    model_config = {"from_attributes": True}


class StaffPreferredSessionCreate(BaseModel):
    session_id: int
    priority: int = 1


class StaffPreferredSessionResponse(BaseModel):
    id: int
    session_id: int
    priority: int
    session: SessionResponse | None = None

    model_config = {"from_attributes": True}


class StaffAvailabilityCreate(BaseModel):
    start_time: datetime
    end_time: datetime

    @model_validator(mode="after")
    def validate_time_range(self):
        if self.start_time >= self.end_time:
            raise ValueError("start_time must be before end_time")
        return self


class StaffAvailabilityResponse(BaseModel):
    id: int
    start_time: datetime
    end_time: datetime

    model_config = {"from_attributes": True}


class StaffCreate(BaseModel):
    name: str
    slack_name: str = ""
    english_ok: bool = False
    role: list[str] = ["session"]
    max_hours: int = 8
    experience_count: int = 0
    emergency_contact: str = ""
    skills: list[str] = []
    preferred_sessions: list[StaffPreferredSessionCreate] = []
    availabilities: list[StaffAvailabilityCreate] = []


class StaffUpdate(BaseModel):
    name: str
    slack_name: str = ""
    english_ok: bool = False
    role: list[str] = ["session"]
    max_hours: int = 8
    experience_count: int = 0
    emergency_contact: str = ""
    skills: list[str] = []


class StaffResponse(BaseModel):
    id: int
    name: str
    slack_name: str
    photo: str
    english_ok: bool
    role: list[str]
    max_hours: int
    experience_count: int
    emergency_contact: str
    skills: list[StaffSkillResponse] = []
    preferred_sessions: list[StaffPreferredSessionResponse] = []
    availabilities: list[StaffAvailabilityResponse] = []

    model_config = {"from_attributes": True}

    @field_validator("emergency_contact", mode="before")
    @classmethod
    def _default_emergency_contact(cls, v):
        return v or ""

    @field_validator("role", mode="before")
    @classmethod
    def _split_role(cls, v):
        if isinstance(v, str):
            return [r for r in v.split(",") if r]
        return v


# --- Assignment ---
class AssignmentResponse(BaseModel):
    id: int
    session_id: int
    staff_id: int
    role: str
    session: SessionResponse | None = None
    staff: StaffResponse | None = None

    model_config = {"from_attributes": True}


class AssignmentCreate(BaseModel):
    session_id: int
    staff_id: int
    role: str = "support"


# --- Schedule output ---
class AssignedStaffEntry(BaseModel):
    assignment_id: int
    staff: StaffResponse


class ScheduleEntry(BaseModel):
    session: SessionResponse
    assigned_staff: list[AssignedStaffEntry]


class ScheduleResponse(BaseModel):
    schedule: list[ScheduleEntry]


class StaffScheduleEntry(BaseModel):
    staff: StaffResponse
    assigned_sessions: list[SessionResponse]


class StaffScheduleResponse(BaseModel):
    staff_assignments: list[StaffScheduleEntry]
