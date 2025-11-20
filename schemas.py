# schemas.py
from datetime import datetime
from pydantic import BaseModel


class UserCreate(BaseModel):
    username: str
    password: str
    color: str | None = None


class UserOut(BaseModel):
    id: int
    username: str
    color: str
    is_admin: bool

    class Config:
        orm_mode = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    username: str
    password: str


class MessageCreate(BaseModel):
    content: str


class MessageOut(BaseModel):
    id: int
    username: str
    color: str
    is_admin: bool
    content: str
    created_at: datetime

    class Config:
        orm_mode = True
