from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

DB_PATH = Path(__file__).parent / "aeyes.db"


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                type       TEXT NOT NULL,
                event      TEXT,
                input_text TEXT,
                response   TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, created_at);
            CREATE TABLE IF NOT EXISTS locations (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL REFERENCES users(id),
                name       TEXT NOT NULL,
                lat        REAL NOT NULL,
                lon        REAL NOT NULL,
                address    TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_locations_user ON locations(user_id);
        """)
        await db.commit()

    # migrations — one try/except per column so already-migrated DBs skip cleanly
    migrations = [
        "ALTER TABLE users    ADD COLUMN display_name  TEXT",
        "ALTER TABLE history  ADD COLUMN lat           REAL",
        "ALTER TABLE history  ADD COLUMN lon           REAL",
        "ALTER TABLE history  ADD COLUMN location_id   INTEGER",
        "ALTER TABLE history  ADD COLUMN location_name TEXT",
    ]
    async with aiosqlite.connect(DB_PATH) as db:
        for sql in migrations:
            try:
                await db.execute(sql)
                await db.commit()
            except Exception:
                pass  # column already exists


# ── Users ─────────────────────────────────────────────────────────────────────

async def create_user(username: str, password_hash: str) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, password_hash, _now()),
        )
        await db.commit()
        return cur.lastrowid  # type: ignore[return-value]


async def get_user(username: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE username = ?", (username,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def get_user_by_id(user_id: int) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
            row = await cur.fetchone()
            return dict(row) if row else None


async def update_display_name(user_id: int, display_name: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))
        await db.commit()


async def update_password(user_id: int, password_hash: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
        await db.commit()


# ── Locations ─────────────────────────────────────────────────────────────────

async def add_location(
    user_id: int, name: str, lat: float, lon: float, address: str | None
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO locations (user_id, name, lat, lon, address, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, name, lat, lon, address, _now()),
        )
        await db.commit()
        return cur.lastrowid  # type: ignore[return-value]


async def get_locations(user_id: int) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM locations WHERE user_id = ? ORDER BY created_at ASC", (user_id,)
        ) as cur:
            return [dict(r) for r in await cur.fetchall()]


async def delete_location(location_id: int, user_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM locations WHERE id = ? AND user_id = ?", (location_id, user_id))
        await db.commit()


async def update_location_name(location_id: int, user_id: int, name: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE locations SET name = ? WHERE id = ? AND user_id = ?", (name, location_id, user_id)
        )
        await db.commit()


# ── History ───────────────────────────────────────────────────────────────────

async def add_history(
    user_id: int,
    type: str,
    response: str,
    input_text: str | None = None,
    event: str | None = None,
    lat: float | None = None,
    lon: float | None = None,
    location_id: int | None = None,
    location_name: str | None = None,
) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO history"
            " (user_id, type, event, input_text, response, created_at, lat, lon, location_id, location_name)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, type, event, input_text, response, _now(), lat, lon, location_id, location_name),
        )
        await db.commit()


async def get_history(
    user_id: int,
    limit: int = 20,
    location_id: int | None = None,
) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if location_id is not None:
            sql = "SELECT * FROM history WHERE user_id = ? AND location_id = ? ORDER BY created_at DESC LIMIT ?"
            params = (user_id, location_id, limit)
        else:
            sql = "SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
            params = (user_id, limit)
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in reversed(rows)]


async def count_history(user_id: int) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT COUNT(*) FROM history WHERE user_id = ?", (user_id,)) as cur:
            row = await cur.fetchone()
            return row[0] if row else 0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
