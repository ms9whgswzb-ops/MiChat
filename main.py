# main.py
import os
from typing import List, Optional, Dict

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    status,
    WebSocket,
    WebSocketDisconnect,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_

from dotenv import load_dotenv

from db import Base, engine, SessionLocal
from models import User, Message
from schemas import (
    UserCreate,
    UserOut,
    Token,
    LoginRequest,
    MessageCreate,
    PrivateMessageCreate,
    MessageOut,
)
from auth import (
    hash_password,
    verify_password,
    create_access_token,
    decode_access_token,
    user_to_token_data,
)

load_dotenv()

# ---------- DB Setup ----------
Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------- FastAPI Setup ----------
app = FastAPI(title="MiChat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # für Produktion einschränken
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


# ---------- Auth Helper ----------
def get_current_user(token: Optional[str] = None, db: Session = Depends(get_db)) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token fehlt")

    if token.lower().startswith("bearer "):
        token = token.split(" ", 1)[1]

    try:
        payload = decode_access_token(token)
        user_id = int(payload.get("sub"))
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Ungültiger oder abgelaufener Token",
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Benutzer nicht gefunden")

    return user


# ---------- Admin anlegen ----------
def create_admin_if_needed(db: Session):
    admin_username = os.getenv("ADMIN_USERNAME", "admin")
    admin_password = os.getenv("ADMIN_PASSWORD", "admin")
    admin_color = os.getenv("ADMIN_COLOR", "#ff0000")

    admin = db.query(User).filter(User.username == admin_username).first()
    if admin:
        return

    admin = User(
        username=admin_username,
        password_hash=hash_password(admin_password),
        color=admin_color,
        is_admin=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    print(f"Admin-User '{admin_username}' angelegt.")


@app.on_event("startup")
def on_startup():
    db = SessionLocal()
    try:
        create_admin_if_needed(db)
    finally:
        db.close()


# ---------- WebSocket Connection Manager ----------
class ConnectionManager:
    def __init__(self):
        # user_id -> Liste von WebSocket-Verbindungen
        self.active_connections: Dict[int, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: int):
        await websocket.accept()
        self.active_connections.setdefault(user_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket, user_id: int):
        conns = self.active_connections.get(user_id)
        if not conns:
            return
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            del self.active_connections[user_id]

    async def send_personal(self, user_id: int, message: dict):
        conns = self.active_connections.get(user_id, [])
        to_remove = []
        for ws in conns:
            try:
                await ws.send_json(message)
            except WebSocketDisconnect:
                to_remove.append(ws)
            except Exception:
                to_remove.append(ws)
        for ws in to_remove:
            self.disconnect(ws, user_id)

    async def broadcast(self, message: dict):
        # An alle verbundenen User senden
        for uid in list(self.active_connections.keys()):
            await self.send_personal(uid, message)


manager = ConnectionManager()


# ---------- Routes (HTML) ----------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ---------- Auth- & User-Routen ----------
@app.post("/register", response_model=UserOut)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.username == user_in.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Benutzername ist bereits vergeben")

    if user_in.username.lower() == os.getenv("ADMIN_USERNAME", "admin").lower():
        raise HTTPException(status_code=400, detail="Dieser Benutzername ist reserviert")

    color = user_in.color or "#ffffff"

    user = User(
        username=user_in.username,
        password_hash=hash_password(user_in.password),
        color=color,
        is_admin=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@app.post("/login", response_model=Token)
def login(login_in: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == login_in.username).first()
    if not user or not verify_password(login_in.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Falscher Benutzername oder Passwort")

    token_data = user_to_token_data(user)
    access_token = create_access_token(token_data)
    return Token(access_token=access_token, token_type="bearer")


@app.get("/me", response_model=UserOut)
def me(token: str, db: Session = Depends(get_db)):
    user = get_current_user(token, db)
    return user


@app.get("/users", response_model=List[UserOut])
def list_users(token: str, db: Session = Depends(get_db)):
    current_user = get_current_user(token, db)
    users = db.query(User).order_by(User.username.asc()).all()
    return users


# ---------- HTTP: Nachrichten laden (History) ----------
@app.get("/messages", response_model=List[MessageOut])
def get_public_messages(
    limit: int = 50,
    db: Session = Depends(get_db),
):
    query = (
        db.query(Message)
        .join(User, Message.user_id == User.id)
        .filter(Message.recipient_id.is_(None))
        .order_by(Message.id.desc())
    )

    messages = query.limit(limit).all()
    messages = list(reversed(messages))

    result: List[MessageOut] = []
    for m in messages:
        result.append(
            MessageOut(
                id=m.id,
                user_id=m.user_id,
                username=m.user.username,
                color=m.user.color,
                is_admin=m.user.is_admin,
                recipient_id=m.recipient_id,
                content=m.content,
                created_at=m.created_at,
            )
        )
    return result


@app.get("/private/messages", response_model=List[MessageOut])
def get_private_messages(
    with_user_id: int,
    token: str,
    limit: int = 100,
    db: Session = Depends(get_db),
):
    current_user = get_current_user(token, db)

    query = (
        db.query(Message)
        .join(User, Message.user_id == User.id)
        .filter(
            Message.recipient_id.isnot(None),
            or_(
                and_(Message.user_id == current_user.id, Message.recipient_id == with_user_id),
                and_(Message.user_id == with_user_id, Message.recipient_id == current_user.id),
            ),
        )
        .order_by(Message.id.desc())
    )

    messages = query.limit(limit).all()
    messages = list(reversed(messages))

    result: List[MessageOut] = []
    for m in messages:
        result.append(
            MessageOut(
                id=m.id,
                user_id=m.user_id,
                username=m.user.username,
                color=m.user.color,
                is_admin=m.user.is_admin,
                recipient_id=m.recipient_id,
                content=m.content,
                created_at=m.created_at,
            )
        )
    return result


# ---------- WebSocket: Chat in Echtzeit ----------
@app.websocket("/ws")
async def websocket_chat(websocket: WebSocket, token: str = Query(...)):
    # Token ohne "Bearer " erwarten
    try:
        payload = decode_access_token(token)
        user_id = int(payload.get("sub"))
    except Exception:
        await websocket.close(code=1008)
        return

    db = SessionLocal()
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        await websocket.close(code=1008)
        db.close()
        return

    await manager.connect(websocket, user_id)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            content = (data.get("content") or "").strip()

            if not content:
                continue

            if msg_type == "public_message":
                # globale Nachricht
                message = Message(user_id=user.id, recipient_id=None, content=content)
                db.add(message)
                db.commit()
                db.refresh(message)

                payload = {
                    "id": message.id,
                    "user_id": user.id,
                    "username": user.username,
                    "color": user.color,
                    "is_admin": user.is_admin,
                    "recipient_id": None,
                    "content": message.content,
                    "created_at": message.created_at.isoformat(),
                }
                await manager.broadcast(payload)

            elif msg_type == "private_message":
                recipient_id = data.get("recipient_id")
                if not isinstance(recipient_id, int):
                    continue

                recipient = db.query(User).filter(User.id == recipient_id).first()
                if not recipient:
                    continue

                if recipient.id == user.id:
                    # optional: sich selbst schreiben -> erlauben oder nicht
                    pass

                message = Message(
                    user_id=user.id,
                    recipient_id=recipient.id,
                    content=content,
                )
                db.add(message)
                db.commit()
                db.refresh(message)

                payload = {
                    "id": message.id,
                    "user_id": user.id,
                    "username": user.username,
                    "color": user.color,
                    "is_admin": user.is_admin,
                    "recipient_id": recipient.id,
                    "content": message.content,
                    "created_at": message.created_at.isoformat(),
                }

                # an Sender & Empfänger senden (falls online)
                await manager.send_personal(user.id, payload)
                if recipient.id != user.id:
                    await manager.send_personal(recipient.id, payload)

            else:
                # unbekannter Typ, ignorieren
                continue

    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)
    except Exception:
        manager.disconnect(websocket, user_id)
    finally:
        db.close()
