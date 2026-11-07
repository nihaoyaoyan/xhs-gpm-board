"""SQLite → PostgreSQL 数据搬迁脚本

用法（在服务器上，先准备好 PG 连接串）：

    cd backend
    python scripts/migrate_sqlite_to_pg.py \
        --target "postgresql+asyncpg://xhs:<密码>@<主机>:5432/xhs_insight"

可选参数：
    --source PATH          源 SQLite 文件（默认 backend/data/xhs.db）
    --tables a,b,c         只搬指定表（默认全部，按外键依赖顺序）
    --batch-size N         每批插入行数（默认 2000）
    --append               不清空目标表，直接追加（默认先清空再搬，保证幂等）
    --dry-run              只统计源表行数，不写入
    --skip-stamp           跳过 alembic stamp（默认自动执行 alembic stamp head）

脚本自动处理三类 SQLite→PG 类型差异：
    1. Boolean 列：SQLite 的 0/1 → Python bool
    2. JSON 列：   若读到字符串 → json.loads 还原为对象（PG 上写入 JSONB）
    3. 时间列：    naive datetime 视为 UTC，补上 tzinfo 后写入 timestamptz

写入完成后自动重置 PG 自增序列，后续应用写入不会主键冲突。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app.db.base import Base  # noqa: E402
import app.models  # noqa: F401,E402  # 导入以注册全部模型

DEFAULT_SOURCE = BACKEND_DIR / "data" / "xhs.db"


def _coerce(value, column: sa.Column):
    """按目标列类型修正从 SQLite 读出的值。"""
    if value is None:
        return None
    col_type = column.type
    if isinstance(col_type, sa.Boolean):
        return bool(value)
    if isinstance(col_type, (sa.JSON,)) and isinstance(value, str):
        # JSON/JSONB 列读到字符串时还原对象
        return json.loads(value)
    if isinstance(col_type, sa.DateTime) and isinstance(value, datetime) and value.tzinfo is None:
        if getattr(col_type, "timezone", False):
            return value.replace(tzinfo=timezone.utc)
    return value


async def _copy_table(source_engine, target_engine, table: sa.Table, batch_size: int, append: bool) -> tuple[int, int]:
    """返回 (源行数, 已写入行数)。按自增主键 id 做游标分页，读取时由 SQLAlchemy 完成类型转换。"""
    quoted = f'"{table.name}"'
    async with source_engine.connect() as src:
        total = (await src.execute(sa.text(f"SELECT COUNT(*) FROM {quoted}"))).scalar_one()

        async with target_engine.begin() as dst:
            if not append:
                await dst.execute(sa.text(f"DELETE FROM {quoted}"))
            if total == 0:
                return 0, 0

            columns = {c.name: c for c in table.columns}
            last_id = 0
            written = 0
            while True:
                result = await src.execute(
                    sa.select(table).where(table.c.id > last_id).order_by(table.c.id).limit(batch_size)
                )
                rows = result.mappings().all()
                if not rows:
                    break
                payload = [
                    {key: _coerce(row.get(key), col) for key, col in columns.items()}
                    for row in rows
                ]
                await dst.execute(table.insert(), payload)
                written += len(payload)
                last_id = rows[-1]["id"]
        return total, written


async def _reset_sequences(target_engine, tables) -> list[str]:
    """把 PG 自增序列拨到当前最大 id 之后。"""
    reset = []
    async with target_engine.begin() as conn:
        for table in tables:
            pk_cols = [c for c in table.primary_key.columns]
            if len(pk_cols) != 1 or not isinstance(pk_cols[0].type, sa.Integer):
                continue
            pk = pk_cols[0]
            if not pk.autoincrement:
                continue
            name = table.name
            seq = (
                await conn.execute(
                    sa.text("SELECT pg_get_serial_sequence(:t, :pk)"),
                    {"t": name, "pk": pk.name},
                )
            ).scalar()
            if not seq:
                continue
            max_id = (
                await conn.execute(sa.text(f'SELECT COALESCE(MAX("{pk.name}"), 0) FROM "{name}"'))
            ).scalar_one()
            next_val = max_id + 1
            await conn.execute(
                sa.text("SELECT setval(:seq, :v, false)"), {"seq": seq, "v": next_val}
            )
            reset.append(f"{name} -> {next_val}")
    return reset


async def _counts(engine, tables) -> dict[str, int]:
    async with engine.connect() as conn:
        return {
            t.name: (
                await conn.execute(sa.text(f'SELECT COUNT(*) FROM "{t.name}"'))
            ).scalar_one()
            for t in tables
        }


async def run(args: argparse.Namespace) -> int:
    source_url = f"sqlite+aiosqlite:///{args.source}"
    if not Path(args.source).exists():
        print(f"[错误] 源文件不存在: {args.source}")
        return 1
    if not args.dry_run:
        if not args.target:
            print("[错误] 需要 --target postgresql+asyncpg:// 或 postgresql+psycopg:// 连接串")
            return 1
        if not args.target.startswith(("postgresql+asyncpg://", "postgresql+psycopg://", "postgresql://")):
            print("[错误] --target 需为 postgresql+asyncpg:// 或 postgresql+psycopg:// 连接串")
            return 1

    source_engine = create_async_engine(source_url)
    target_engine = create_async_engine(args.target, pool_pre_ping=True) if not args.dry_run else None

    tables = Base.metadata.sorted_tables
    if args.tables:
        wanted = {name.strip() for name in args.tables.split(",")}
        tables = [t for t in tables if t.name in wanted]

    try:
        if args.dry_run:
            print("== dry-run：源表行数统计 ==")
            src_counts = await _counts(source_engine, tables)
            for name, count in src_counts.items():
                print(f"  {name:<20} {count:>8}")
            print(f"合计 {sum(src_counts.values())} 行，{len(src_counts)} 张表")
            return 0

        print("== 在目标库建表（create_all，已存在则跳过）==")
        async with target_engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))

        print("== 开始搬迁 ==")
        started = time.time()
        total_src, total_dst = 0, 0
        for table in tables:
            t0 = time.time()
            src_n, dst_n = await _copy_table(source_engine, target_engine, table, args.batch_size, args.append)
            total_src += src_n
            total_dst += dst_n
            status = "OK" if src_n == dst_n else "MISMATCH"
            print(
                f"  {table.name:<20} 源 {src_n:>7} → 写入 {dst_n:>7}  [{status}]  {time.time() - t0:.1f}s"
            )
        print(f"== 搬迁完成：{total_dst}/{total_src} 行，耗时 {time.time() - started:.1f}s ==")

        if total_src != total_dst:
            print("[警告] 行数不一致，请检查上方 MISMATCH 的表")
            return 2

        reset = await _reset_sequences(target_engine, tables)
        print("== 序列重置 ==")
        for item in reset:
            print(f"  {item}")

        if not args.skip_stamp:
            print("== alembic stamp head ==")
            proc = subprocess.run(
                [sys.executable, "-m", "alembic", "stamp", "head"],
                cwd=BACKEND_DIR,
                env={**os.environ, "DATABASE_URL": args.target},
                capture_output=True,
                text=True,
            )
            if proc.returncode == 0:
                print("  完成（后续可在目标库上正常跑 alembic upgrade）")
            else:
                print(f"  [失败，可稍后手动执行 alembic stamp head] {proc.stderr.strip()[:200]}")

        print("== 校验目标库 ==")
        src_counts = await _counts(source_engine, tables)
        dst_counts = await _counts(target_engine, tables)
        all_ok = True
        for t in tables:
            ok = src_counts.get(t.name, 0) == dst_counts.get(t.name, 0)
            all_ok &= ok
            mark = "OK" if ok else "MISMATCH"
            print(f"  {t.name:<20} 源 {src_counts.get(t.name, 0):>7} / 目标 {dst_counts.get(t.name, 0):>7}  [{mark}]")
        return 0 if all_ok else 2
    finally:
        await source_engine.dispose()
        if target_engine is not None:
            await target_engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="SQLite → PostgreSQL 数据搬迁")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="源 SQLite 文件路径")
    parser.add_argument("--target", help="目标 PG 连接串 postgresql+asyncpg://user:pass@host:5432/db（dry-run 可省略）")
    parser.add_argument("--tables", help="仅搬指定表，逗号分隔（默认全部）")
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--append", action="store_true", help="追加模式（默认先清空目标表）")
    parser.add_argument("--dry-run", action="store_true", help="只统计源行数，不写入")
    parser.add_argument("--skip-stamp", action="store_true", help="跳过 alembic stamp head")
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
