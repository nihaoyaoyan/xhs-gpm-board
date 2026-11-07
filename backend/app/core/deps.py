from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models import User

bearer_scheme = HTTPBearer(auto_error=False)

DbSession = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(
    db: DbSession,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或凭证缺失")
    try:
        payload = decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态已失效，请重新登录")
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录凭证无效")
    user = await db.scalar(select(User).where(User.username == username))
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号不存在或已停用")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_service_token(
    x_service_token: Annotated[str | None, Header(alias="X-Service-Token")] = None,
) -> bool:
    """MCP 等内部服务调用入口，使用静态令牌鉴权。"""
    if not x_service_token or x_service_token != settings.mcp_api_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="服务令牌无效")
    return True


ServiceAuth = Annotated[bool, Depends(require_service_token)]


async def allow_user_or_service(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    x_service_token: Annotated[str | None, Header(alias="X-Service-Token")] = None,
) -> None:
    """读接口同时接受用户 JWT 与内部服务令牌（供 MCP 调用）。"""
    if x_service_token and x_service_token == settings.mcp_api_token:
        return
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或凭证缺失")
    try:
        decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态已失效，请重新登录")


AuthGuard = Annotated[None, Depends(allow_user_or_service)]
