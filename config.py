"""Muat konfigurasi dari .env (dotenv)."""
import os
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent / ".env"

try:
    from dotenv import load_dotenv
    load_dotenv(ENV_PATH, override=True)
except Exception:
    pass


def _bool(name: str, default: bool = False) -> bool:
    return (os.getenv(name, "true" if default else "false") or "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


class Config:
    def __init__(self) -> None:
        # ── Telegram userbot ────────────────────────────────────────────────
        self.api_id = _int("API_ID", 0)
        self.api_hash = (os.getenv("API_HASH", "") or "").strip()
        self.phone = (os.getenv("PHONE", "") or "").strip() or None
        self.session_name = (os.getenv("SESSION_NAME", "userbot") or "userbot").strip()
        self.owner_id = _int("OWNER_ID", 0)
        self.owner_username = (os.getenv("OWNER_USERNAME", "") or "").strip().lstrip("@") or None

        # ── AI provider (9router / OpenAI-compatible) ───────────────────────
        self.ai_base_url = (os.getenv("AI_BASE_URL", "") or "").strip().rstrip("/")
        self.ai_api_key = (os.getenv("AI_API_KEY", "") or "").strip()
        self.ai_model = (os.getenv("AI_MODEL", "") or "").strip()

        # ── Fallback models (auto-fallback chain) ──────────────────────────
        self.ai_fallbacks = self._parse_fallbacks(os.getenv("AI_FALLBACKS", ""))

        # ── AI behavior ────────────────────────────────────────────────────
        self.ai_system_prompt = (os.getenv("AI_SYSTEM_PROMPT", "") or "").strip()
        self.ai_max_history = _int("AI_MAX_HISTORY", 200)
        self.ai_context_limit = _int("AI_CONTEXT_LIMIT", 30)
        self.ai_timeout = _int("AI_TIMEOUT_MS", 30000) / 1000.0
        self.ai_cooldown_seconds = _int("AI_COOLDOWN_SECONDS", 60)
        self.ai_enabled_default = _bool("AI_ENABLED_DEFAULT", True)
        self.ai_reply_in_groups = _bool("AI_REPLY_IN_GROUPS", False)

        # ── Upstash Redis (training data) ──────────────────────────────────
        self.upstash_url = (os.getenv("UPSTASH_REDIS_URL", "") or "").strip()
        self.upstash_token = (os.getenv("UPSTASH_REDIS_TOKEN", "") or "").strip()

        # ── Training data keys ─────────────────────────────────────────────
        self.training_key = (os.getenv("TRAINING_KEY", "telegram:training_data") or "").strip()
        self.profile_key = (os.getenv("PROFILE_KEY", "telegram:chat_profile") or "").strip()

        # ── Agent tools (gratis, tanpa API key) ────────────────────────────
        self.ai_tools = _bool("AI_TOOLS", True)

    @staticmethod
    def _parse_fallbacks(raw: str) -> list[dict]:
        """Parse AI_FALLBACKS="name|url|model|key;name2|url2|model2|key2" """
        out: list[dict] = []
        for i, s in enumerate([x.strip() for x in (raw or "").split(";") if x.strip()]):
            parts = [p.strip() for p in s.split("|")]
            if len(parts) < 3:
                continue
            name = parts[0] or f"fallback-{i + 1}"
            base_url = parts[1].rstrip("/") if parts[1] else ""
            model = parts[2] if len(parts) > 2 else ""
            api_key = parts[3] if len(parts) > 3 else ""
            if base_url:
                out.append({
                    "name": name,
                    "base_url": base_url,
                    "model": model,
                    "api_key": api_key,
                })
        return out

    @property
    def providers(self) -> list[dict]:
        """Urutan provider: primary → fallbacks (auto-fallback chain)."""
        out: list[dict] = []
        if self.ai_base_url:
            out.append({
                "name": "primary",
                "base_url": self.ai_base_url,
                "model": self.ai_model,
                "api_key": self.ai_api_key,
            })
        out.extend(self.ai_fallbacks)
        return out

    @property
    def ai_configured(self) -> bool:
        return bool(self.ai_base_url or self.ai_fallbacks)

    @property
    def upstash_configured(self) -> bool:
        return bool(self.upstash_url and self.upstash_token)


config = Config()
