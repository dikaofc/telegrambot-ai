"""Inti AI auto-reply: training data dari Upstash, auto-fallback multi-model, tool calling."""
import asyncio
import json
import re
import time
from collections import deque
from pathlib import Path

import httpx

from config import config
from logger import logger
from tools import calculate, get_time

STATE_PATH = Path("data/ai-state.json")

SYSTEM_BASE = (
    "Kamu itu {name} ({username}). Kamu ORANG NYATA, bukan AI, bukan bot.\n"
    "Kamu lagi chat di Telegram.\n\n"
    "Cara kamu ngobrol ada di contoh di bawah. TIRU persis gaya itu.\n"
    "Kalau ditanya 'siapa kamu' → jawab sebagai {name}.\n"
    "Kalau ditanya 'kamu AI ya' → bilang enggak/bukan.\n"
    "JANGAN PERNAH sebut AI, OpenAI, Claude, LLM, atau apapun yang nunjukin kamu bot.\n")


def sanitize_reply(text: str) -> str:
    """Bersihkan chain-of-thought / reasoning biar cuma jawaban final yang keluar."""
    if not text:
        return ""
    # buang <thinking>...</thinking> blocks
    text = re.sub(r"<(thinking|reasoning|thought|analysis)>.*?</\1>", "", text, flags=re.S | re.I)
    # buang special tokens reasoning
    text = re.sub(r"<\|(startofreasoning|endofreasoning)\|>.*?(?=<|$)", "", text, flags=re.S)
    text = text.strip()
    return text


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (s or "").lower()))


def _similarity(a: str, b: str) -> float:
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


class RateLimitError(Exception):
    """Provider kena rate-limit (HTTP 429)."""


# ── training data loader dari Upstash ──────────────────────────────────────
class TrainingDataLoader:
    """Load training data dari Upstash Redis."""

    def __init__(self):
        self._cache: list[dict] = []
        self._profile: dict = {}
        self._loaded = False
        self._last_load = 0.0
        self._reload_interval = 3600.0  # reload tiap jam

    async def _get_upstash(self):
        """Create Upstash REST API client."""
        if not config.upstash_configured:
            return None
        try:
            from upstash import UpstashClient
            return UpstashClient(
                url=config.upstash_url,
                token=config.upstash_token,
            )
        except Exception as e:
            logger.warning("gagal koneksi Upstash: %s", e)
            return None

    async def load(self, force: bool = False) -> None:
        """Load training data dari Upstash ke cache lokal."""
        if self._loaded and not force and (time.time() - self._last_load) < self._reload_interval:
            return

        print("    [upstash] connecting...")
        upstash = await self._get_upstash()
        if not upstash:
            print("    [upstash] tidak terkonfigurasi — skip")
            return

        try:
            # Baca index chunks
            print("    [upstash] reading index...")
            index_raw = await upstash.get(f"{config.training_key}:index")
            if not index_raw:
                print("    [upstash] tidak ada training data")
                return

            chunk_keys = json.loads(index_raw)
            print(f"    [upstash] loading {len(chunk_keys)} chunks...")
            all_data = []
            for i, key in enumerate(chunk_keys):
                chunk_raw = await upstash.get(key)
                if chunk_raw:
                    all_data.extend(json.loads(chunk_raw))
                if (i + 1) % 10 == 0:
                    print(f"    [upstash] ...{i + 1}/{len(chunk_keys)} chunks")

            self._cache = all_data

            # Baca profile
            profile_raw = await upstash.get(config.profile_key)
            if profile_raw:
                self._profile = json.loads(profile_raw)

            self._loaded = True
            self._last_load = time.time()
            logger.info(
                "training data loaded dari Upstash: %d pesan, nama=%s",
                len(self._cache),
                self._profile.get("name", "?"),
            )
        except Exception as e:
            logger.warning("gagal load training data dari Upstash: %s", e)

    def get_style_examples(self, chat_id: str | None = None, limit: int = 20) -> list[dict]:
        """Ambil contoh gaya chat dari training data + corpus real-time."""
        # Gabung cache Upstash + corpus real-time
        data = self._cache + [
            {"text": c["text"], "fromMe": c["fromMe"], "chat_id": c["chat_id"]}
            for c in self.corpus
        ]
        if not data:
            return []

        # Filter per chat kalau ada
        if chat_id:
            chat_msgs = [d for d in data if d.get("chat_id") == chat_id]
            if len(chat_msgs) >= 5:
                data = chat_msgs

        # Ambil yang dari "kamu" (fromMe=True) — ini gaya asli lu
        mine = [d for d in data if d.get("fromMe")]
        theirs = [d for d in data if not d.get("fromMe")]

        # Prioritas: lebih banyak contoh gaya KAMU
        result = []
        for m in mine[-limit:]:
            result.append({"role": "assistant", "content": m["text"]})
        for m in theirs[-limit // 2:]:
            result.append({"role": "user", "content": m["text"]})

        return result

    def get_user_name(self) -> str:
        return self._profile.get("name", "User")

    def get_username(self) -> str:
        return self._profile.get("username", "")

    def get_stats(self) -> dict:
        return {
            "total": len(self._cache),
            "from_me": sum(1 for d in self._cache if d.get("fromMe")),
            "from_others": sum(1 for d in self._cache if not d.get("fromMe")),
            "name": self._profile.get("name", "?"),
        }


# ── deteksi mode/topik percakapan ─────────────────────────────────────────
_MODE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("mesra", ["sayang", "cinta", "beb", "baby", "love", "kangen", "rindu", "peluk", "cium", "pacar", "bby", "💕", "❤️", "😘", "😍"]),
    ("kasar", ["anjing", "anjir", "njir", "goblok", "tolol", "bangsat", "fuck", "shit", "bego", "bacot", "asu", "jancok"]),
    ("sopan", ["selamat pagi", "selamat siang", "selamat malam", "permisi", "mohon", "terima kasih", "assalamualaikum", "dengan hormat", "pak", "bu", "kak"]),
]

_MODE_HINTS = {
    "mesra": "Nada: mesra/romantis — lembut, perhatian, balas kayak orang deket.",
    "kasar": "Nada: gaul, boleh nyeletuk kasar biar nyambung sama lawan bicara.",
    "sopan": "Nada: sopan & formal.",
}


def _kw_match(text: str, kw: str) -> bool:
    if kw.isalpha():
        return bool(re.search(rf"\b{re.escape(kw)}\b", text))
    return kw in text


def detect_mode(text: str) -> str | None:
    t = (text or "").lower()
    for mode, kws in _MODE_KEYWORDS:
        for kw in kws:
            if _kw_match(t, kw):
                return mode
    return None


# ── main AI class ─────────────────────────────────────────────────────────
class AutoReply:
    def __init__(self) -> None:
        self.enabled = config.ai_enabled_default
        self.blacklist: set[str] = set()
        self.memory: list[str] = []
        self.chat_history: dict[str, deque] = {}
        self.training = TrainingDataLoader()
        self._lock = asyncio.Lock()
        self._cooldown_until = 0.0
        self._dirty = False
        # Real-time learning: corpus + buffer buat upload ke Upstash
        self.corpus: list[dict] = []  # [{text, fromMe, chat_id, ts}]
        self._pending_upload: list[dict] = []  # buffer belum di-upload
        self._upload_task = None

    # ── state persistence ───────────────────────────────────────────────────
    async def init(self) -> None:
        print("  [ai] load state lokal...")
        # Load state lokal
        try:
            if STATE_PATH.exists():
                d = json.loads(STATE_PATH.read_text(encoding="utf-8"))
                self.enabled = bool(d.get("enabled", self.enabled))
                self.blacklist = {str(x) for x in (d.get("blacklist") or [])}
                self.memory = [str(x) for x in (d.get("memory") or [])]
        except Exception as e:
            print(f"  [ai] warning: {e}")

        print("  [ai] load training data dari Upstash...")
        # Load training data dari Upstash
        await self.training.load(force=True)

        print(f"  [ai] done: enabled={self.enabled}, memory={len(self.memory)}, training={self.training.get_stats()['total']} pesan")

    async def _save(self) -> None:
        try:
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "enabled": self.enabled,
                "blacklist": sorted(self.blacklist),
                "memory": self.memory[-200:],
            }
            STATE_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            self._dirty = False
        except Exception as e:
            logger.warning("gagal simpan ai-state: %s", e)

    # ── real-time learning ─────────────────────────────────────────────────
    def learn_one(self, text: str, from_me: bool, chat_id) -> None:
        """Pelajari satu pesan masuk/keluar & buffer buat upload ke Upstash."""
        text = (text or "").strip()
        if len(text) < 2 or len(text) > 2000:
            return
        if text.startswith("/") or text.startswith("."):
            return
        entry = {
            "text": text,
            "fromMe": bool(from_me),
            "chat_id": str(chat_id),
            "ts": int(time.time()),
        }
        self.corpus.append(entry)
        self._pending_upload.append(entry)
        # Batasi corpus di memori
        if len(self.corpus) > 2000:
            self.corpus = self.corpus[-2000:]

    def _start_upload_loop(self) -> None:
        """Start background task buat upload pending messages ke Upstash."""
        if self._upload_task is None:
            self._upload_task = asyncio.create_task(self._upload_loop())

    async def _upload_loop(self) -> None:
        """Upload pending messages ke Upstash tiap 60 detik."""
        while True:
            await asyncio.sleep(60)
            await self._flush_to_upstash()

    async def _flush_to_upstash(self) -> None:
        """Upload semua pending messages ke Upstash."""
        if not self._pending_upload:
            return
        if not config.upstash_configured:
            return
        try:
            from upstash import UpstashClient
            upstash = UpstashClient(
                url=config.upstash_url,
                token=config.upstash_token,
            )
            # Ambil data lama
            index_raw = await upstash.get(f"{config.training_key}:index")
            old_keys = json.loads(index_raw) if index_raw else []
            old_data = []
            for key in old_keys:
                chunk_raw = await upstash.get(key)
                if chunk_raw:
                    old_data.extend(json.loads(chunk_raw))

            # Gabung dengan data baru
            all_data = old_data + self._pending_upload
            # Ambil 2000 terakhir
            all_data = all_data[-2000:]

            # Upload ulang
            CHUNK_SIZE = 100
            new_keys = []
            for i in range(0, len(all_data), CHUNK_SIZE):
                chunk = all_data[i:i + CHUNK_SIZE]
                chunk_key = f"{config.training_key}:chunk:{i // CHUNK_SIZE}"
                await upstash.set(chunk_key, json.dumps(chunk, ensure_ascii=False))
                new_keys.append(chunk_key)

            await upstash.set(f"{config.training_key}:index", json.dumps(new_keys))
            await upstash.set(f"{config.training_key}:total", str(len(all_data)))

            uploaded = len(self._pending_upload)
            self._pending_upload.clear()
            print(f"  [upload] {uploaded} pesan baru → Upstash (total: {len(all_data)})")
        except Exception as e:
            print(f"  [upload] gagal: {e}")

    def is_enabled(self) -> bool:
        return self.enabled

    def is_configured(self) -> bool:
        return config.ai_configured

    async def set_enabled(self, v: bool) -> None:
        self.enabled = v
        await self._save()

    # ── blacklist ───────────────────────────────────────────────────────────
    def is_blacklisted(self, chat_id) -> bool:
        return str(chat_id) in self.blacklist

    async def add_to_blacklist(self, ident: str) -> tuple[str, bool]:
        ident = str(ident).strip()
        added = ident not in self.blacklist
        if added:
            self.blacklist.add(ident)
            await self._save()
        return ident, added

    async def remove_from_blacklist(self, ident: str) -> tuple[str, bool]:
        ident = str(ident).strip()
        removed = ident in self.blacklist
        if removed:
            self.blacklist.discard(ident)
            await self._save()
        return ident, removed

    def list_blacklist(self) -> list[str]:
        return sorted(self.blacklist)

    # ── memori ──────────────────────────────────────────────────────────────
    def list_memory(self) -> list[str]:
        return list(self.memory)

    async def clear_memory(self) -> None:
        self.memory = []
        await self._save()

    async def remember(self, fact: str) -> str:
        fact = fact.strip()
        if not fact:
            return "fakta kosong"
        if fact not in self.memory:
            self.memory.append(fact)
            if len(self.memory) > 200:
                self.memory = self.memory[-200:]
            await self._save()
        return "tersimpan"

    def recall(self, query: str) -> str:
        if not self.memory:
            return "(memori kosong)"
        q = (query or "").lower()
        hits = [m for m in self.memory if q in m.lower()]
        if not hits:
            hits = self.memory[-20:]
        return "\n".join(f"- {m}" for m in hits)

    # ── tool schemas & executor ─────────────────────────────────────────────
    def _tool_schemas(self) -> list[dict]:
        if not config.ai_tools:
            return []
        return [
            {
                "type": "function",
                "function": {
                    "name": "get_time",
                    "description": "Waktu/tanggal sekarang (WIB)",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "calculate",
                    "description": "Hitung ekspresi matematika",
                    "parameters": {
                        "type": "object",
                        "properties": {"expression": {"type": "string"}},
                        "required": ["expression"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "remember_fact",
                    "description": "Simpan fakta penting yang diceritakan user (nama, kesukaan, janji)",
                    "parameters": {
                        "type": "object",
                        "properties": {"fact": {"type": "string"}},
                        "required": ["fact"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "recall_facts",
                    "description": "Ingat fakta tersimpan yang relevan dengan pertanyaan",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            },
        ]

    async def _run_tool(self, name: str, args: dict) -> str:
        try:
            if name == "get_time":
                return get_time()
            if name == "calculate":
                return calculate(str(args.get("expression", ""))) or "gagal hitung"
            if name == "remember_fact":
                return await self.remember(str(args.get("fact", "")))
            if name == "recall_facts":
                return self.recall(str(args.get("query", "")))
            return "tool tidak dikenal"
        except Exception as e:
            return f"tool error: {e}"

    # ── LLM calls (auto-fallback chain) ────────────────────────────────────
    def _headers(self, provider: dict) -> dict:
        h = {"Content-Type": "application/json"}
        if provider.get("api_key"):
            h["Authorization"] = f"Bearer {provider['api_key']}"
        return h

    async def _call(self, provider: dict, messages: list[dict], tools: list[dict]) -> str | None:
        """Satu provider, termasuk loop tool-calling."""
        body = {"model": provider["model"], "messages": messages, "temperature": 0.7}
        if tools:
            body["tools"] = tools
        url = f"{provider['base_url']}/chat/completions"

        for _ in range(4):
            async with httpx.AsyncClient(timeout=config.ai_timeout) as c:
                r = await c.post(url, headers=self._headers(provider), json=body)

            if r.status_code == 429:
                raise RateLimitError(f"{provider['name']} rate-limited")
            if r.status_code >= 400:
                raise RuntimeError(f"{provider['name']} HTTP {r.status_code}: {r.text[:200]}")

            data = r.json()
            msg = (data.get("choices") or [{}])[0].get("message") or {}
            content = sanitize_reply(msg.get("content") or "")
            tool_calls = msg.get("tool_calls") or []

            if not tool_calls:
                return content or None

            # jalankan tools lalu lanjutkan
            messages.append(msg)
            for tc in tool_calls:
                fn = tc.get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                result = await self._run_tool(fn.get("name", ""), args)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": result,
                })
            body = {"model": provider["model"], "messages": messages, "temperature": 0.7}

        return None

    async def _complete(self, messages: list[dict], tools: list[dict]) -> str | None:
        """Coba provider berurutan (primary → fallback)."""
        last_err = "tidak ada provider"
        rate_limited = False

        for provider in config.providers:
            try:
                reply = await self._call(provider, messages, tools)
                if reply:
                    return reply
            except RateLimitError:
                rate_limited = True
                last_err = f"{provider['name']} rate-limited"
                logger.debug("provider %s rate-limited", provider["name"])
                await asyncio.sleep(1.5)
                continue
            except Exception as e:
                last_err = str(e)
                logger.warning("provider %s gagal: %s", provider["name"], e)
                continue

        if rate_limited:
            self._cooldown_until = time.time() + config.ai_cooldown_seconds
            logger.warning("semua provider rate-limited → dijeda %ss", config.ai_cooldown_seconds)
        else:
            logger.error("semua provider gagal: %s", last_err)
        return None

    # ── prompt building ─────────────────────────────────────────────────────
    def _system(self, name: str, chat_id, mode: str | None = None) -> str:
        # Dapat identity dari training data
        display_name = self.training.get_user_name() or name
        username = self.training.get_username() or "dikaacode"

        if config.ai_system_prompt:
            sys = config.ai_system_prompt.replace("{name}", display_name)
        else:
            sys = SYSTEM_BASE.replace("{name}", display_name).replace("{username}", f"@{username}")

        # ── GAYA CHAT DARI DATA SCRAPE — ini yang paling penting ──
        style_examples = self.training.get_style_examples(chat_id, limit=40)
        if style_examples:
            mine = [e for e in style_examples if e["role"] == "assistant"]
            theirs = [e for e in style_examples if e["role"] == "user"]

            if mine:
                sys += "\n\n=== CARA KAMU NGOMONG (tiru persis) ==="
                for i, ex in enumerate(mine):
                    sys += f"\n{i+1}. {ex['content']}"

            if theirs:
                sys += "\n\n=== CONTOH OBROLAN ==="
                # Tampilkan alternating biar keliatan flow chat-nya
                paired = list(zip(theirs[-10:], mine[-10:])) if len(theirs) >= len(mine) else list(zip(theirs, mine))
                for user_msg, my_msg in paired:
                    sys += f"\nUser: {user_msg['content']}"
                    sys += f"\nKamu: {my_msg['content']}"

            sys += "\n\n=== BALAS PESAN DENGAN GAYA PERSIS DI ATAS ==="

        # Tambah memori
        if self.memory:
            sys += "\n\nFakta yang kamu ingat:\n" + "\n".join(f"- {m}" for m in self.memory[-15:])

        # Mode hint
        if mode and mode in _MODE_HINTS:
            sys += "\n\n" + _MODE_HINTS[mode]

        return sys

    def _recent(self, chat_id) -> list[dict]:
        return list(self.chat_history.get(str(chat_id), []))

    def _push_history(self, chat_id, role: str, content: str) -> None:
        key = str(chat_id)
        q = self.chat_history.setdefault(key, deque(maxlen=config.ai_context_limit))
        q.append({"role": role, "content": content})

    def detect_mode(self, chat_id, content: str) -> str | None:
        """Public: deteksi mode chat."""
        texts = [content]
        for m in self._recent(chat_id):
            if m.get("role") == "user":
                texts.append(m.get("content", ""))
        for t in texts[:5]:
            mode = detect_mode(t)
            if mode:
                return mode
        return None

    # ── pipeline utama ─────────────────────────────────────────────────────
    async def handle(
        self,
        chat_id,
        name: str,
        text: str | None = None,
        media_kind: str | None = None,
        replied_to_me: bool = False,
    ) -> str | None:
        """Balas otomatis. Return teks balasan atau None (skip)."""
        if not self.enabled:
            return None
        if time.time() < self._cooldown_until:
            return None
        if self.is_blacklisted(chat_id):
            return None

        content = (text or "").strip()
        if not content:
            return None
        if len(content) > 4000:
            content = content[:4000]

        mode = self.detect_mode(chat_id, content)

        async with self._lock:
            messages = [{"role": "system", "content": self._system(name, chat_id, mode)}]
            for m in self._recent(chat_id):
                messages.append(m)
            messages.append({"role": "user", "content": content})

            tools = self._tool_schemas() if config.ai_tools else []
            reply = await self._complete(messages, tools)
            if not reply:
                return None

            # skip command-like replies
            if reply.lstrip().startswith("/"):
                return None

            # anti-pengulangan
            prev_replies = [m["content"] for m in self._recent(chat_id) if m.get("role") == "assistant"]
            if any(_similarity(r, reply) >= 0.6 for r in prev_replies[-3:]):
                retry = messages + [
                    {"role": "assistant", "content": reply},
                    {"role": "user", "content": "Jawabanmu barusan mirip banget sama yang sebelumnya. Jawab beda & natural."},
                ]
                alt = await self._complete(retry, [])
                if alt and not any(_similarity(r, alt) >= 0.6 for r in prev_replies[-3:]):
                    reply = alt
                else:
                    return None

            self._push_history(chat_id, "user", content)
            self._push_history(chat_id, "assistant", reply)
            return reply

    async def test(self, text: str) -> str | None:
        return await self.handle("__test__", self.training.get_user_name(), text=text)

    def stats(self) -> dict:
        return self.training.get_stats()


ai = AutoReply()
