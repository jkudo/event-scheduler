"""
Bot / abuse protection utilities.

- Rate limiting per IP (in-memory, resets on restart)
- Login brute-force lockout
- Security headers middleware
"""

import time
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


# ---------------------------------------------------------------------------
# Rate limiter (in-memory, per-IP)
# ---------------------------------------------------------------------------
class _RateBucket:
    """Sliding-window counter for a single IP."""
    __slots__ = ("hits", "window_start")

    def __init__(self):
        self.hits = 0
        self.window_start = 0.0


class RateLimiter:
    """Simple in-memory sliding-window rate limiter."""

    def __init__(self):
        # path_prefix -> {ip -> _RateBucket}
        self._buckets: dict[str, dict[str, _RateBucket]] = defaultdict(dict)
        # path_prefix -> (max_requests, window_seconds)
        self._rules: list[tuple[str, int, int]] = []

    def add_rule(self, path_prefix: str, max_requests: int, window_seconds: int):
        self._rules.append((path_prefix, max_requests, window_seconds))

    def is_limited(self, path: str, client_ip: str) -> bool:
        now = time.time()
        for prefix, max_req, window in self._rules:
            if not path.startswith(prefix):
                continue
            buckets = self._buckets[prefix]
            bucket = buckets.get(client_ip)
            if bucket is None:
                bucket = _RateBucket()
                buckets[client_ip] = bucket
            # Reset window if expired
            if now - bucket.window_start >= window:
                bucket.hits = 0
                bucket.window_start = now
            bucket.hits += 1
            if bucket.hits > max_req:
                return True
        return False

    def cleanup(self, max_age: float = 3600):
        """Remove stale entries older than max_age seconds."""
        now = time.time()
        for prefix in list(self._buckets.keys()):
            buckets = self._buckets[prefix]
            stale = [ip for ip, b in buckets.items() if now - b.window_start > max_age]
            for ip in stale:
                del buckets[ip]


# Global rate limiter instance
rate_limiter = RateLimiter()

# Login: 5 attempts per 60 seconds per IP
rate_limiter.add_rule("/auth/verify", max_requests=5, window_seconds=60)

# API writes: 60 requests per 60 seconds per IP
rate_limiter.add_rule("/api/", max_requests=60, window_seconds=60)


# ---------------------------------------------------------------------------
# Login brute-force lockout
# ---------------------------------------------------------------------------
_login_failures: dict[str, list[float]] = defaultdict(list)
LOGIN_LOCKOUT_THRESHOLD = 10  # failures within window
LOGIN_LOCKOUT_WINDOW = 300    # 5 minutes
LOGIN_LOCKOUT_DURATION = 600  # 10 minutes lockout


def record_login_failure(client_ip: str):
    """Record a failed login attempt."""
    _login_failures[client_ip].append(time.time())


def is_login_locked(client_ip: str) -> bool:
    """Check if IP is locked out due to too many failures."""
    now = time.time()
    attempts = _login_failures.get(client_ip)
    if not attempts:
        return False
    # Keep only recent attempts
    recent = [t for t in attempts if now - t < LOGIN_LOCKOUT_WINDOW]
    _login_failures[client_ip] = recent
    if len(recent) >= LOGIN_LOCKOUT_THRESHOLD:
        # Check if last failure was within lockout duration
        if recent and now - recent[-1] < LOGIN_LOCKOUT_DURATION:
            return True
    return False


def clear_login_failures(client_ip: str):
    """Clear failure records after successful login."""
    _login_failures.pop(client_ip, None)


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        # Prevent MIME-type sniffing
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Prevent clickjacking
        response.headers["X-Frame-Options"] = "DENY"
        # XSS filter (legacy browsers)
        response.headers["X-XSS-Protection"] = "1; mode=block"
        # Referrer policy
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Permissions policy — disable unnecessary APIs
        response.headers["Permissions-Policy"] = (
            "camera=(), microphone=(), geolocation=(), payment=()"
        )
        return response


# ---------------------------------------------------------------------------
# Rate limiting middleware
# ---------------------------------------------------------------------------
class RateLimitMiddleware(BaseHTTPMiddleware):
    """Apply rate limiting based on configured rules."""

    async def dispatch(self, request: Request, call_next) -> Response:
        from .auth_middleware import _get_client_ip

        path = request.url.path
        client_ip = _get_client_ip(request)

        # Check login lockout
        if path == "/auth/verify" and is_login_locked(client_ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "ログイン試行回数が上限を超えました。しばらくしてから再試行してください。"},
            )

        # Check rate limit
        if rate_limiter.is_limited(path, client_ip):
            return JSONResponse(
                status_code=429,
                content={"detail": "リクエストが多すぎます。しばらくしてから再試行してください。"},
            )

        # Periodic cleanup (roughly every 1000 requests)
        import random
        if random.random() < 0.001:
            rate_limiter.cleanup()

        return await call_next(request)
