from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import jwt
import pytest

import auth


async def test_register_returns_token(client):
    r = await client.post("/auth/register", json={"username": "alice", "password": "secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "alice"
    assert body["display_name"] == "alice"
    assert body["token"]


async def test_register_short_password_400(client):
    r = await client.post("/auth/register", json={"username": "alice", "password": "no"})
    assert r.status_code == 400


async def test_register_short_username_400(client):
    r = await client.post("/auth/register", json={"username": "a", "password": "secret"})
    assert r.status_code == 400


async def test_register_duplicate_409(client):
    await client.post("/auth/register", json={"username": "alice", "password": "secret"})
    r = await client.post("/auth/register", json={"username": "alice", "password": "another"})
    assert r.status_code == 409


async def test_login_success(client):
    await client.post("/auth/register", json={"username": "alice", "password": "secret"})
    r = await client.post("/auth/login", json={"username": "alice", "password": "secret"})
    assert r.status_code == 200
    assert r.json()["username"] == "alice"


async def test_login_wrong_password_401(client):
    await client.post("/auth/register", json={"username": "alice", "password": "secret"})
    r = await client.post("/auth/login", json={"username": "alice", "password": "wrong"})
    assert r.status_code == 401


async def test_login_unknown_user_401(client):
    r = await client.post("/auth/login", json={"username": "nobody", "password": "secret"})
    assert r.status_code == 401


async def test_protected_endpoint_no_header_401(client):
    r = await client.get("/profile")
    assert r.status_code == 401


async def test_jwt_round_trip():
    token = auth.create_token(42, "alice")
    decoded = auth._decode(token)
    assert int(decoded["sub"]) == 42
    assert decoded["username"] == "alice"


async def test_expired_token_rejected(client):
    expired_payload = {
        "sub": "1",
        "username": "alice",
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
    }
    expired_token = jwt.encode(expired_payload, auth._SECRET, algorithm=auth._ALGO)
    r = await client.get("/profile", headers={"Authorization": f"Bearer {expired_token}"})
    assert r.status_code == 401
