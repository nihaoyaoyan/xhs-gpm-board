from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1 import ad_reports, ads, auth, comments, dashboard, metrics, orders, search_terms, shops, sync
from app.core.config import settings
from app.core.deps import DbSession
from app.core.errors import register_exception_handlers
from app.db.base import Base
from app.db.session import engine, get_db
from app.scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.auto_create_tables:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    start_scheduler()
    yield
    stop_scheduler()
    await engine.dispose()


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)

for router in (
    auth.router,
    shops.router,
    sync.router,
    dashboard.router,
    orders.router,
    ads.router,
    ad_reports.router,
    comments.router,
    metrics.router,
    search_terms.router,
):
    app.include_router(router, prefix=settings.api_prefix)


@app.api_route("/health", methods=["GET", "HEAD"], tags=["health"])
async def health(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        return {"status": "ok", "db": "ok"}
    except Exception as exc:
        return {"status": "degraded", "db": f"error: {exc}"}


# 生产构建产物由后端同端口托管，前端不依赖 Vite 也能访问（http://<host>:8000）
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

if (WEB_DIST / "index.html").is_file():
    if (WEB_DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa_fallback(full_path: str):
        no_cache = {"Cache-Control": "no-cache, no-store, must-revalidate"}
        target = (WEB_DIST / full_path).resolve()
        if full_path and target.is_file() and WEB_DIST.resolve() in target.parents:
            return FileResponse(target, headers=no_cache)
        return FileResponse(WEB_DIST / "index.html", headers=no_cache)
