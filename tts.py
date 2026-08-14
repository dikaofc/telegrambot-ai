"""Text-to-speech via Microsoft Edge TTS (gratis, tanpa key)."""

from config import config
from logger import logger

try:
    import edge_tts

    HAS_TTS = True
except Exception:  # edge-tts belum terpasang
    edge_tts = None
    HAS_TTS = False


async def synthesize(text: str) -> bytes | None:
    """Ubah teks jadi audio OGG (bytes). Return None kalau gagal/tidak tersedia."""
    if not HAS_TTS or not text:
        return None
    try:
        communicate = edge_tts.Communicate(text, config.tts_voice)
        chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)
    except Exception as e:
        logger.warning("TTS gagal: %s", e)
        return None
