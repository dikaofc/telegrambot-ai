"""Muat konfigurasi dari .env (dotenv)."""
import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"

try:
    from dotenv import load_dotenv

    load_dotenv(ENV_PATH, override=True)
except Exception:  # dotenv opsional
    pass


def _bool(name: str, default: bool = False) -> bool:
    return (os.getenv(name, "true" if default else "false") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def parse_providers(raw: str) -> list[dict]:
    out: list[dict] = []
    for i, s in enumerate([x.strip() for x in (raw or "").split(";") if x.strip()]):
        parts = [p.strip() for p in s.split("|")]
        if len(parts) < 4:
            continue
        name, base_url, model, api_key = parts[0], parts[1], parts[2], parts[3]
        if not base_url:
            continue
        out.append(
            {
                "name": name or f"fallback-{i + 1}",
                "base_url": base_url.rstrip("/"),
                "model": model or "",
                "api_key": api_key or "",
            }
        )
    return out


class Config:
    def __init__(self) -> None:
        self.api_id = _int("API_ID", 0)
        self.api_hash = (os.getenv("API_HASH", "") or "").strip()
        self.phone = (os.getenv("PHONE", "") or "").strip() or None
        self.session_name = (os.getenv("SESSION_NAME", "userbot") or "userbot").strip()
        self.owner_id = _int("OWNER_ID", 0)
        self.owner_username = (os.getenv("OWNER_USERNAME", "") or "").strip().lstrip("@") or None
        self.ai_api_key = (os.getenv("AI_API_KEY", "") or os.getenv("OPENAI_API_KEY", "") or "").strip()
        self.ai_base_url = (os.getenv("AI_BASE_URL", "") or "").strip().rstrip("/")
        self.ai_model = (os.getenv("AI_MODEL", "gpt-4o-mini") or "gpt-4o-mini").strip()
        self.ai_fallbacks = parse_providers(os.getenv("AI_FALLBACKS", ""))
        self.ai_ollama_model = (os.getenv("AI_OLLAMA_MODEL", "llama3.1") or "llama3.1").strip()
        self.ai_system_prompt = (os.getenv("AI_SYSTEM_PROMPT", "") or "").strip()
        self.ai_max_history = _int("AI_MAX_HISTORY", 9000)
        self.ai_context_limit = _int("AI_CONTEXT_LIMIT", 30)
        self.ai_timeout = _int("AI_TIMEOUT_MS", 25000) / 1000.0
        self.ai_cooldown_seconds = _int("AI_COOLDOWN_SECONDS", 60)
        self.ai_mode_learn_threshold = _int("AI_MODE_LEARN_THRESHOLD", 4)
        self.ai_enabled_default = _bool("AI_ENABLED_DEFAULT", True)
        self.ai_reply_in_groups = _bool("AI_REPLY_IN_GROUPS", False)
        self.ai_reply_to_stickers = _bool("AI_REPLY_TO_STICKERS", True)
        self.ai_reply_to_media = _bool("AI_REPLY_TO_MEDIA", True)
        sticker = (os.getenv("AI_REPLY_STICKER", "sticker") or "sticker").strip().lower()
        self.ai_reply_sticker = sticker if sticker in ("off", "sticker", "always") else "sticker"

        # ── Belajar dari riwayat (bootstrap saat start) ───────────────────────
        self.ai_bootstrap = _bool("AI_BOOTSTRAP", True)
        self.ai_bootstrap_dialogs = _int("AI_BOOTSTRAP_DIALOGS", 30)
        self.ai_bootstrap_messages = _int("AI_BOOTSTRAP_MESSAGES", 200)

        # ── Agent tools ─────────────────────────────────────────────────────
        self.ai_tools = _bool("AI_TOOLS", True)
        self.ai_web_search = _bool("AI_WEB_SEARCH", True)
        self.ai_weather = _bool("AI_WEATHER", True)
        self.ai_currency = _bool("AI_CURRENCY", True)
        self.ai_max_memory = _int("AI_MAX_MEMORY", 500)

        # ── STT / TTS ───────────────────────────────────────────────────────
        self.stt_api_key = (os.getenv("STT_API_KEY", "") or "").strip()
        self.stt_base_url = (os.getenv("STT_BASE_URL", "https://api.groq.com/openai/v1") or "").strip().rstrip("/")
        self.stt_model = (os.getenv("STT_MODEL", "whisper-large-v3-turbo") or "whisper-large-v3-turbo").strip()
        self.stt_language = (os.getenv("STT_LANGUAGE", "id") or "id").strip() or "id"
        self.tts_voice = (os.getenv("TTS_VOICE", "id-ID-ArdiNeural") or "id-ID-ArdiNeural").strip()
        voice = (os.getenv("AI_REPLY_VOICE", "voice") or "voice").strip().lower()
        self.ai_reply_voice = voice if voice in ("voice", "always", "off") else "voice"

    @property
    def providers(self) -> list[dict]:
        """Urutan provider: primary → fallback → Ollama lokal (tanpa key)."""
        out: list[dict] = []
        if self.ai_base_url:
            out.append(
                {
                    "name": "primary",
                    "base_url": self.ai_base_url,
                    "model": self.ai_model,
                    "api_key": self.ai_api_key,
                }
            )
        out.extend(self.ai_fallbacks)
        out.append(
            {
                "name": "ollama-local",
                "base_url": "http://localhost:11434/v1",
                "model": self.ai_ollama_model,
                "api_key": "",
            }
        )
        return out

    @property
    def ai_configured(self) -> bool:
        return bool(self.ai_base_url or self.ai_fallbacks)


config = Config()
