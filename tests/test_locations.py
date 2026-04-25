from __future__ import annotations


async def test_create_location_returns_id(client, auth_headers):
    r = await client.post(
        "/locations", json={"name": "Home", "lat": 40.7, "lon": -74.0}, headers=auth_headers
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Home"
    assert "id" in body


async def test_create_location_empty_name_400(client, auth_headers):
    r = await client.post(
        "/locations", json={"name": "  ", "lat": 1.0, "lon": 1.0}, headers=auth_headers
    )
    assert r.status_code == 400


async def test_create_location_bad_lat_400(client, auth_headers):
    r = await client.post(
        "/locations", json={"name": "X", "lat": 200.0, "lon": 0.0}, headers=auth_headers
    )
    assert r.status_code == 400


async def test_create_location_bad_lon_400(client, auth_headers):
    r = await client.post(
        "/locations", json={"name": "X", "lat": 0.0, "lon": -300.0}, headers=auth_headers
    )
    assert r.status_code == 400


async def test_list_locations_per_user(client, auth_headers):
    await client.post(
        "/locations", json={"name": "Home", "lat": 40.0, "lon": -74.0}, headers=auth_headers
    )
    r = await client.get("/locations", headers=auth_headers)
    assert r.status_code == 200
    assert [loc["name"] for loc in r.json()] == ["Home"]


async def test_delete_location(client, auth_headers):
    created = await client.post(
        "/locations", json={"name": "X", "lat": 1.0, "lon": 1.0}, headers=auth_headers
    )
    loc_id = created.json()["id"]
    r = await client.delete(f"/locations/{loc_id}", headers=auth_headers)
    assert r.status_code == 200
    listed = (await client.get("/locations", headers=auth_headers)).json()
    assert listed == []


async def test_rename_location(client, auth_headers):
    created = await client.post(
        "/locations", json={"name": "X", "lat": 1.0, "lon": 1.0}, headers=auth_headers
    )
    loc_id = created.json()["id"]
    r = await client.patch(
        f"/locations/{loc_id}", json={"name": "Renamed"}, headers=auth_headers
    )
    assert r.status_code == 200
    listed = (await client.get("/locations", headers=auth_headers)).json()
    assert listed[0]["name"] == "Renamed"


async def test_cross_user_isolation(client, register_user):
    """Locations saved by alice must not be visible to bob."""
    alice = await register_user(client, "alice", "secret")
    bob = await register_user(client, "bob", "secret")
    alice_h = {"Authorization": f"Bearer {alice['token']}"}
    bob_h = {"Authorization": f"Bearer {bob['token']}"}

    await client.post(
        "/locations", json={"name": "AliceHome", "lat": 1.0, "lon": 2.0}, headers=alice_h
    )
    bob_locs = (await client.get("/locations", headers=bob_h)).json()
    assert bob_locs == []
