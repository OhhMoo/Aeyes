from __future__ import annotations


async def test_get_profile(client, auth_headers):
    # one history row so the count is non-zero
    await client.post("/chat", json={"text": "hi"}, headers=auth_headers)
    r = await client.get("/profile", headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "alice"
    assert body["display_name"] == "alice"
    assert body["history_count"] == 1
    assert "member_since" in body


async def test_patch_display_name(client, auth_headers):
    r = await client.patch("/profile", json={"display_name": "Alice the First"}, headers=auth_headers)
    assert r.status_code == 200
    p = (await client.get("/profile", headers=auth_headers)).json()
    assert p["display_name"] == "Alice the First"


async def test_patch_display_name_empty_400(client, auth_headers):
    r = await client.patch("/profile", json={"display_name": "   "}, headers=auth_headers)
    assert r.status_code == 400


async def test_patch_password_requires_current(client, auth_headers):
    r = await client.patch("/profile", json={"new_password": "newer"}, headers=auth_headers)
    assert r.status_code == 400


async def test_patch_password_wrong_current_401(client, auth_headers):
    r = await client.patch(
        "/profile",
        json={"current_password": "wrong", "new_password": "newer"},
        headers=auth_headers,
    )
    assert r.status_code == 401


async def test_patch_password_short_400(client, auth_headers):
    r = await client.patch(
        "/profile",
        json={"current_password": "secret", "new_password": "x"},
        headers=auth_headers,
    )
    assert r.status_code == 400


async def test_patch_password_success(client, auth_headers):
    r = await client.patch(
        "/profile",
        json={"current_password": "secret", "new_password": "newer-secret"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    # old password no longer works
    bad = await client.post("/auth/login", json={"username": "alice", "password": "secret"})
    assert bad.status_code == 401
    # new password works
    good = await client.post("/auth/login", json={"username": "alice", "password": "newer-secret"})
    assert good.status_code == 200
