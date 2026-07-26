"""Password hashing utilities using PBKDF2-SHA256."""

import base64
import hashlib
import hmac
import os

_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    """Hash a password with a random salt. Returns 'salt$hash' string."""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    """Verify a password against a stored hash. Also accepts plaintext for migration."""
    if "$" not in stored:
        # Legacy plaintext — caller should re-hash after successful verify
        return password == stored
    salt_b64, dk_b64 = stored.split("$", 1)
    salt = base64.b64decode(salt_b64)
    expected = base64.b64decode(dk_b64)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _ITERATIONS)
    return hmac.compare_digest(dk, expected)


def is_hashed(stored: str) -> bool:
    """Check if a stored value is already hashed (contains '$' separator)."""
    return "$" in stored
