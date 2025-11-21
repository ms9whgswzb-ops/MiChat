# models.py
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from db import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    color = Column(String(7), default="#ffffff")

    is_admin = Column(Boolean, default=False)
    is_banned = Column(Boolean, default=False)
    muted_until = Column(DateTime, nullable=True)

    messages = relationship("Message", back_populates="user", foreign_keys="Message.user_id")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)  # Sender
    recipient_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # None = global
    content = Column(String(1000), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", foreign_keys=[user_id], back_populates="messages")
