import asyncio
import httpx
from typing import Optional

_HTTP_CLIENT: Optional[httpx.AsyncClient] = None
_CLIENT_LOOP: Optional[asyncio.AbstractEventLoop] = None


def get_http_client() -> httpx.AsyncClient:
    """Returns a shared, pooled httpx.AsyncClient instance with persistent connection pooling
    and HTTP keep-alive, tied to the active asyncio event loop.
    Re-creates the client if the event loop changes (e.g. between test cases).
    """
    global _HTTP_CLIENT, _CLIENT_LOOP
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None

    if _HTTP_CLIENT is None or _HTTP_CLIENT.is_closed or _CLIENT_LOOP is not current_loop:
        _HTTP_CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=3.0),
            limits=httpx.Limits(max_keepalive_connections=50, max_connections=100),
            headers={"User-Agent": "EcoRoad-Engine/3.0"}
        )
        _CLIENT_LOOP = current_loop
    return _HTTP_CLIENT


async def close_http_client():
    """Gracefully closes the pooled HTTP client."""
    global _HTTP_CLIENT, _CLIENT_LOOP
    if _HTTP_CLIENT is not None and not _HTTP_CLIENT.is_closed:
        await _HTTP_CLIENT.aclose()
        _HTTP_CLIENT = None
        _CLIENT_LOOP = None
