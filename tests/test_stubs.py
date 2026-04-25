from __future__ import annotations


async def test_investigate_response_shape(client):
    r = await client.post("/investigate", json={"event": "_describe", "image_b64": "x"})
    assert r.status_code == 200
    body = r.json()
    assert {"event", "prompt", "response", "elapsed_seconds", "success"} <= body.keys()
    assert body["success"] is True
    assert isinstance(body["elapsed_seconds"], (int, float))


async def test_investigate_unauthenticated_does_not_persist(client):
    """Unauthenticated requests still work but aren't saved."""
    await client.post("/investigate", json={"event": "_describe", "image_b64": "x"})
    # No auth header → no way to read history, but we can register fresh and confirm empty
    r = await client.post("/auth/register", json={"username": "alice", "password": "secret"})
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    rows = (await client.get("/history", headers=headers)).json()
    assert rows == []


async def test_analyze_change_response_shape(client):
    r = await client.post("/analyze-change", json={"frame0_b64": "a", "frame1_b64": "b"})
    assert r.status_code == 200
    body = r.json()
    assert {"response", "elapsed_seconds", "success"} <= body.keys()
    assert body["success"] is True


async def test_chat_no_history_returns_text(client, auth_headers):
    r = await client.post("/chat", json={"text": "hi"}, headers=auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "hi"
    assert body["audio_b64"] is None  # ElevenLabs mocked off
    assert body["referenced_location"] is None


async def test_chat_referenced_location_for_object_query(client, auth_headers):
    """When the user asks 'where did I see X' and history mentions X, the
    response should populate referenced_location with the matching capture."""
    # Seed: investigate at known coords; the stub response contains the word
    # "describe" — so a query for "describe" will match.
    await client.post(
        "/investigate",
        json={"event": "_describe", "image_b64": "x", "lat": 40.0, "lon": -74.0},
        headers=auth_headers,
    )
    r = await client.post(
        "/chat", json={"text": "where did I see describe?"}, headers=auth_headers
    )
    body = r.json()
    assert body["success"] is True
    ref = body["referenced_location"]
    assert ref is not None
    assert ref["lat"] == 40.0
    assert ref["lon"] == -74.0


async def test_chat_referenced_location_for_named_location(client, auth_headers):
    """Asking about a saved location by name should reference it."""
    await client.post(
        "/locations", json={"name": "kitchen", "lat": 1.0, "lon": 2.0}, headers=auth_headers
    )
    r = await client.post(
        "/chat", json={"text": "what's in my kitchen?"}, headers=auth_headers
    )
    body = r.json()
    assert body["referenced_location"] is not None
    assert body["referenced_location"]["name"] == "kitchen"


async def test_safe_mode_with_image(client, auth_headers):
    r = await client.post(
        "/safe-mode", json={"image_b64": "x"}, headers=auth_headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert "1 recent frame" in body["response"]


async def test_safe_mode_with_recent_frames(client, auth_headers):
    r = await client.post(
        "/safe-mode", json={"recent_frames": ["a", "b", "c"]}, headers=auth_headers
    )
    assert r.status_code == 200
    assert "3 recent frames" in r.json()["response"]


async def test_health(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["mode"] == "stub"


async def test_security_headers_present(client):
    r = await client.get("/health")
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in r.headers
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    # HSTS only set in prod (AEYES_ENV=prod); tests run in dev, so absent.
    assert "Strict-Transport-Security" not in r.headers
