"""Upstash REST API client — using httpx only, no extra packages."""
import json

import httpx

from logger import logger


class UpstashClient:
    """Minimal Upstash Redis REST API client."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    async def get(self, key: str) -> str | None:
        """GET a key from Upstash."""
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(
                    f"{self.url}/get/{key}",
                    headers=self._headers,
                )
                if r.status_code == 200:
                    data = r.json()
                    return data.get("result")
                logger.warning("upstash GET %s: HTTP %s", key, r.status_code)
                return None
        except Exception as e:
            logger.warning("upstash GET %s gagal: %s", key, e)
            return None

    async def set(self, key: str, value: str) -> bool:
        """SET a key in Upstash."""
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(
                    f"{self.url}/set/{key}",
                    headers=self._headers,
                    content=value,
                )
                return r.status_code == 200
        except Exception as e:
            logger.warning("upstash SET %s gagal: %s", key, e)
            return False
