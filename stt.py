"""Speech-to-text via Groq Whisper (OpenAI-compatible)."""

import httpx

from config import config
from logger import logger


async def transcribe(data: bytes, filename: str = "audio.ogg") -> str:
    """Transkripsi voice note jadi teks. Return teks atau '' kalau gagal/tidak dikonfigurasi."""
    if not config.stt_api_key:
        return ""
    if not data:
        return ""
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"{config.stt_base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.stt_api_key}"},
                data={
                    "model": config.stt_model,
                    "language": config.stt_language,
                    "response_format": "json",
                },
                files={"file": (filename, data, "audio/ogg")},
            )
        if r.status_code >= 400:
            logger.warning("STT HTTP %s: %s", r.status_code, r.text[:200])
            return ""
        return (r.json().get("text") or "").strip()
    except Exception as e:
        logger.warning("STT gagal: %s", e)
        return ""
