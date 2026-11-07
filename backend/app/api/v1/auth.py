from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.core.deps import CurrentUser, DbSession
from app.core.errors import ok
from app.core.security import create_access_token, verify_password
from app.models import User
from app.schemas.auth import LoginRequest

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_payload(user: User) -> dict:
    return {"id": user.id, "username": user.username}


@router.post("/login")
async def login(payload: LoginRequest, db: DbSession):
    user = await db.scalar(select(User).where(User.username == payload.username))
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号或密码错误")
    return ok({"access_token": create_access_token(user.username), "user": _user_payload(user)})


@router.get("/me")
async def me(user: CurrentUser):
    return ok(_user_payload(user))
