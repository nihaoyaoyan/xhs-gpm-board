from app.core.security import create_access_token, decode_access_token, hash_password, verify_password


def test_password_hash_roundtrip():
    hashed = hash_password("Admin@12345")
    assert hashed != "Admin@12345"
    assert verify_password("Admin@12345", hashed)
    assert not verify_password("wrong-password", hashed)


def test_access_token_roundtrip():
    token = create_access_token("admin")
    payload = decode_access_token(token)
    assert payload["sub"] == "admin"
    assert payload["type"] == "user"


async def test_login_and_me(api_ctx):
    client = api_ctx.client

    unauthorized = await client.get("/api/v1/auth/me", headers={"Authorization": ""})
    assert unauthorized.status_code == 401

    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "admin"


async def test_login_rejects_wrong_password(api_ctx):
    client = api_ctx.client
    response = await client.post(
        "/api/v1/auth/login", json={"username": "admin", "password": "bad-password"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == 401
