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
    MessageOut,
)
from auth import (
    hash_password,
    verify_password,
    create_access_token,
    decode_access_token,
    user_to_token_data,
)


# ---------- INITIAL SETUP ----------
load_dotenv()
Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


app = FastAPI(title="MiChat")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- STATIC & TEMPLATE PATHS (ABSOLUTE) ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
static_dir = os.path.join(BASE_DIR, "static")
templates_dir = os.path.join(BASE_DIR, "templates")

if not os.path.isdir(static_dir):
    print(f"[WARN] Static directory not found: {static_dir}")

if not os.path.isdir(templates_dir):
    print(f"[WARN] Templates directory not found: {templates_dir}")

app.mount("/static", StaticFiles(directory=static_dir), name="static")
templates = Jinja2Templates(directory=templates_dir)


# ---------- AUTH HELPERS ----------
def get_current_user(token: Optional[str] = None, db: Session = Depends(get_db)) -> User:
    if not token:
        raise HTTPException(status_code=401, detail="Token fehlt")

    # remove "Bearer "
    if token.lower().startswith("bearer "):
        token = token.split(" ", 1)[1]

    try:
        payload = decode_access_token(token)
        user_id = int(payload.get("sub"))
    except Exception:
        raise HTTPException(401, "Ungültiger oder abgelaufener Token")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(401, "Benutzer nicht gefunden")

    return user


# ---------- ADMIN CREATION ----------
def create_admin_if_needed(db: Session):
    admin_username = os.getenv("ADMIN_USERNAME", "admin")
    admin_password = os.getenv("ADMIN_PASSWORD", "admin")
    admin_color = os.getenv("ADMIN_COLOR", "#ff0000")

    admin = db.query(User).filter(User.username == admin_username).first()
    if admin:
        print(f"[ADMIN] Exists (id={admin.id})")
        return

    print(f"[ADMIN] Creating admin user '{admin_username}'")
    u = User(
        username=admin_username,
        password_hash=hash_password(admin_password),
        color=admin_color,
        is_admin=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    print(f"[ADMIN] Admin created (id={u.id})")


@app.on_event("startup")
def startup_event():
    db = SessionLocal()
    create_admin_if_needed(db)
    db.close()


# ---------- WEBSOCKET MANAGER ----------
class ConnectionManager:
    def __init__(self):
        self.active: Dict[int, List[WebSocket]] = {}

    async def connect(self, ws: WebSocket, user_id: int):
        await ws.accept()
        self.active.setdefault(user_id, []).append(ws)

    def disconnect(self, ws: WebSocket, user_id: int):
        conns = self.active.get(user_id)
        if not conns:
            return
        if ws in conns:
            conns.remove(ws)
        if not conns:
            del self.active[user_id]

    async def send_user(self, user_id: int, data: dict):
        if user_id not in self.active:
            return
        dead = []
        for ws in self.active[user_id]:
            try:
                await ws.send_json(data)
            except:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, user_id)

    async def broadcast(self, data: dict):
        for uid in list(self.active.keys()):
            await self.send_user(uid, data)


manager = ConnectionManager()


# ---------- HTML PAGE ----------
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


# ---------- USER CRUD ----------
@app.post("/register", response_model=UserOut)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.username == user_in.username).first()
    if existing:
        raise HTTPException(400, "Benutzername ist bereits vergeben")

    if user_in.username.lower() == os.getenv("ADMIN_USERNAME",
