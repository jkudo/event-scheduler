"""
Simple authentication middleware: password-based login + GeoIP (Japan-only).

Environment variables
---------------------
APP_PASSWORD     : required – shared password for access
SESSION_SECRET   : required – key for cookie signing
GEOIP_ENABLED    : "1" to enable GeoIP check (default: disabled)
IPINFO_TOKEN     : token for ipinfo.io (optional, raises free-tier limit)
"""

import hashlib
import hmac
import json
import os
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import RedirectResponse, JSONResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
if not SESSION_SECRET:
    import secrets
    SESSION_SECRET = secrets.token_hex(32)
    print("[WARNING] SESSION_SECRET not set — generated a random key. Sessions will not survive restarts.")
COOKIE_NAME = "cs_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 7  # 7 days
GEOIP_ENABLED = os.environ.get("GEOIP_ENABLED", "0") == "1"
IPINFO_TOKEN = os.environ.get("IPINFO_TOKEN", "")

# Paths that bypass authentication
PUBLIC_PATHS = {"/auth/login", "/auth/verify", "/auth/logout", "/auth/debug"}


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------
def _sign(payload: str) -> str:
    """Create HMAC signature for payload."""
    return hmac.new(
        SESSION_SECRET.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def make_session_cookie(user_info: dict) -> str:
    """Create a signed cookie value: base64(json)|signature."""
    payload = json.dumps(user_info, ensure_ascii=False)
    sig = _sign(payload)
    return f"{payload}|{sig}"


def verify_session_cookie(cookie_value: str) -> dict | None:
    """Verify and decode session cookie. Returns None if invalid."""
    if not cookie_value or "|" not in cookie_value:
        return None
    payload, sig = cookie_value.rsplit("|", 1)
    if not hmac.compare_digest(_sign(payload), sig):
        return None
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return None
    # Check expiry
    if data.get("exp", 0) < time.time():
        return None
    return data


# ---------------------------------------------------------------------------
# GeoIP check
# ---------------------------------------------------------------------------
_geo_cache: dict[str, tuple[str, float]] = {}
GEO_CACHE_TTL = 60 * 60  # 1 hour


async def _check_geo_jp(client_ip: str) -> bool:
    """Return True if client IP is from Japan (or if check is skipped)."""
    if not GEOIP_ENABLED:
        return True

    # Skip private/local IPs
    if client_ip in ("127.0.0.1", "::1") or client_ip.startswith(("10.", "192.168.", "172.")):
        return True

    # Check cache
    now = time.time()
    if client_ip in _geo_cache:
        country, ts = _geo_cache[client_ip]
        if now - ts < GEO_CACHE_TTL:
            return country == "JP"

    try:
        import httpx
        url = f"https://ipinfo.io/{client_ip}/json"
        params = {}
        if IPINFO_TOKEN:
            params["token"] = IPINFO_TOKEN
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, params=params)
            data = resp.json()
            country = data.get("country", "")
            _geo_cache[client_ip] = (country, now)
            return country == "JP"
    except Exception:
        # On error, allow access (fail-open)
        return True


def _get_client_ip(request: Request) -> str:
    """Extract client IP, respecting proxy headers."""
    # Azure App Service sets X-Forwarded-For (may include port, e.g. "1.2.3.4:12345")
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
        # Strip port if present
        if ":" in ip and not ip.startswith("["):
            ip = ip.rsplit(":", 1)[0]
        return ip
    if request.client:
        return request.client.host
    return "127.0.0.1"


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------
class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Allow auth-related paths
        if path in PUBLIC_PATHS:
            return await call_next(request)

        # Allow static assets on login page
        if path in ("/login.html", "/robots.txt"):
            return await call_next(request)

        # GeoIP check (before auth, blocks entire access)
        if GEOIP_ENABLED:
            client_ip = _get_client_ip(request)
            if not await _check_geo_jp(client_ip):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Access denied: region restricted"},
                )

        # Check session cookie
        cookie = request.cookies.get(COOKIE_NAME)
        session = verify_session_cookie(cookie) if cookie else None

        if session is None:
            # API requests get 401, browser requests get redirected
            if path.startswith("/api/"):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Authentication required"},
                )
            return RedirectResponse(url="/login.html", status_code=302)

        return await call_next(request)
