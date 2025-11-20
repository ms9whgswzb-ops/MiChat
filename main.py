# main.py
import os
from typing import List, Optional

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

from sqlalchemy.orm import Session

from dotenv import load_dotenv

from db import Base, engine, SessionLocal
from models import User, Message
from schemas import (
    UserCreate,
    UserOut,
    Token,
    LoginRequest,
    MessageCreate,
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
    allow_origins=["*"],  # für Produktion: auf deine Domain einschränken
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


# ---------- Routes ----------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


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


@app.post("/messages", response_model=MessageOut)
def send_message(
    msg_in: MessageCreate,
    token: str,
    db: Session = Depends(get_db),
):
    user = get_current_user(token, db)

    if not msg_in.content.strip():
        raise HTTPException(status_code=400, detail="Nachricht darf nicht leer sein")

    message = Message(
        user_id=user.id,
        content=msg_in.content.strip(),
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    return MessageOut(
        id=message.id,
        username=user.username,
        color=user.color,
        is_admin=user.is_admin,
        content=message.content,
        created_at=message.created_at,
    )


@app.get("/messages", response_model=List[MessageOut])
def get_messages(
    limit: int = 50,
    after_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    query = db.query(Message).join(User).order_by(Message.id.desc())

    if after_id is not None:
        query = query.filter(Message.id > after_id)

    messages = query.limit(limit).all()
    messages = list(reversed(messages))  # chronologisch aufsteigend

    result: List[MessageOut] = []
    for m in messages:
        result.append(
            MessageOut(
                id=m.id,
                username=m.user.username,
                color=m.user.color,
                is_admin=m.user.is_admin,
                content=m.content,
                created_at=m.created_at,
            )
        )
    return result
