from __future__ import annotations


async def test_history_requires_auth(client):
    r = await client.get("/history")
    assert r.status_code == 401


async def test_history_empty_for_new_user(client, auth_headers):
    r = await client.get("/history", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == []


async def test_investigate_saves_history(client, auth_headers):
    r = await client.post(
        "/investigate",
        json={"event": "_describe", "image_b64": "data:fake"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["event"] == "_describe"
    assert "elapsed_seconds" in body

    h = await client.get("/history", headers=auth_headers)
    assert h.status_code == 200
    rows = h.json()
    assert len(rows) == 1
    assert rows[0]["type"] == "investigate"


async def test_chat_saves_history_with_input_text(client, auth_headers):
    r = await client.post("/chat", json={"text": "hello"}, headers=auth_headers)
    assert r.status_code == 200
    h = (await client.get("/history", headers=auth_headers)).json()
    assert any(row["type"] == "chat" and row["input_text"] == "hello" for row in h)


async def test_history_limit_param(client, auth_headers):
    for _ in range(5):
        await client.post("/chat", json={"text": "x"}, headers=auth_headers)
    r = await client.get("/history?limit=2", headers=auth_headers)
    assert len(r.json()) == 2


async def test_history_filter_by_location(client, auth_headers):
    # save two locations far apart
    home = await client.post(
        "/locations", json={"name": "home", "lat": 40.0, "lon": -74.0}, headers=auth_headers
    )
    work = await client.post(
        "/locations", json={"name": "work", "lat": 0.0, "lon": 0.0}, headers=auth_headers
    )
    home_id, work_id = home.json()["id"], work.json()["id"]

    # one capture at each location
    await client.post(
        "/investigate",
        json={"event": "_describe", "image_b64": "x", "lat": 40.0, "lon": -74.0},
        headers=auth_headers,
    )
    await client.post(
        "/investigate",
        json={"event": "_describe", "image_b64": "x", "lat": 0.0, "lon": 0.0},
        headers=auth_headers,
    )

    home_rows = (await client.get(f"/history?location_id={home_id}", headers=auth_headers)).json()
    work_rows = (await client.get(f"/history?location_id={work_id}", headers=auth_headers)).json()
    assert len(home_rows) == 1 and home_rows[0]["location_name"] == "home"
    assert len(work_rows) == 1 and work_rows[0]["location_name"] == "work"
