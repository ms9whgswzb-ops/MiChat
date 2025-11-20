# schemas.py
from datetime import datetime
from pydantic import BaseModel, ConfigDict


class UserCreate(BaseModel):
    username: str
    password: str
    color: str | None = None


class UserOut(BaseModel):
    id: int
    username: str
    color: str
    is_admin: bool

    model_config = ConfigDict(from_attributes=True)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    username: str
    password: str


class MessageCreate(BaseModel):
    content: str


class PrivateMessageCreate(BaseModel):
    recipient_id: int
    content: str


class MessageOut(BaseModel):
    id: int
    user_id: int
    username: str
    color: str
    is_admin: bool
    recipient_id: int | None = None
    content: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
