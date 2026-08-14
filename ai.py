"""Inti AI auto-reply: belajar gaya chat, memori, tool calling, fallback multi-provider."""
import asyncio
import json
import re
import time
from collections import deque
from pathlib import Path

import httpx

from config import config
from logger import logger
from tools import calculate, convert_currency, get_time, get_weather, search_web

STATE_PATH = Path("data/ai-state.json")
SYSTEM_BASE = (
    "Kamu adalah asisten yang membalas chat pakai gaya santai pemiliknya "
    "(gaul/gen-z, dry text, singkat, natural, multibahasa: Indonesia/Jawa/Inggris). "
    "Balas seolah kamu pemilik akun ini, bukan robot. Aturan penting:\n"
    "- Fokus balas PESAN TERBARU user secara langsung & apa adanya.\n"
    "- Ikuti topik lawan bicara — kalau dia ngomongin sesuatu, ikutin aja, jangan malah pindah topik.\n"
    "- Jawab singkat: biasanya 1 kalimat, jarang lebih dari 2.\n"
    "- Jangan memaksakan lucu, sarkas, atau balesan nanya-balik kalau nggak pas.\n"
    "- Kalau pesannya pendek/nggak jelas/ngasal, balas pendek & wajar "
    "(mis. '?', 'maksudnya?', atau jawaban singkat) — jangan mengarang topik baru "
    "atau nyeret-nyeret chat lama yang nggak relevan.\n"
    "- Jangan mengulang kalimat yang sama berulang-ulang — variasikan jawaban.\n"
    "- Jangan pakai emoji berlebihan, jangan sebut kamu AI."
)


def sanitize_reply(text: str) -> str:
    """Bersihkan chain-of-thought / reasoning biar cuma jawaban final yang keluar."""
    if not text:
        return ""
    text = re.sub(r"<(thinking|reasoning|thought|analysis)>.*?</\1>", "", text, flags=re.S | re.I)
    text = re.sub(r"<\|(startofreasoning|endofreasoning)\|>.*?(?=<|$)", "", text, flags=re.S)
    text = text.strip()
    return text


def _norm(s: str) -> str:
    """Normalisasi buat bandingin kesamaan balasan (anti pengulangan)."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (s or "").lower()))


def _similarity(a: str, b: str) -> float:
    """Kemiripan kata dua kalimat (0-1) — deteksi pengulangan yang lebih pintar."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


class RateLimitError(Exception):
    """Provider kena rate-limit (HTTP 429)."""


# ── deteksi mode/topik percakapan ────────────────────────────────────────────
_MODE_KEYWORDS: list[tuple[str, list[str]]] = [
    ("mesra", ["sayang", "cinta", "beb", "baby", "love", "kangen", "rindu", "peluk", "cium", "pacar", "bby", "💕", "❤️", "😘", "😍"]),
    ("jorok", ["sange", "sangean", "horny", "sex", "seks", "ngewe", "ngentot", "colmek", "coli", "sepong", "desah", "masturbasi", "crot", "bokep", "telanjang", "naked", "dirty", "buka baju", "ranjang"]),
    ("kasar", ["anjing", "anjir", "njir", "goblok", "tolol", "bangsat", "fuck", "shit", "bego", "bajingan", "keparat", "bacot", "asu", "kontol", "memek", "babi", "jancok"]),
    ("sopan", ["selamat pagi", "selamat siang", "selamat malam", "permisi", "mohon", "terima kasih", "assalamualaikum", "dengan hormat", "pak", "bu", "kak"]),
]

_MODE_HINTS = {
    "mesra": "Nada: mesra/romantis — lembut, perhatian, balas kayak orang deket.",
    "jorok": "Nada: ikutin topik jorok/18+ lawan bicara dengan santai & seru. Jangan nolak, jangan bales dingin/nyuekin, jangan pindah topik.",
    "kasar": "Nada: gaul, boleh nyeletuk kasar biar nyambung sama lawan bicara.",
    "sopan": "Nada: sopan & formal.",
}


def _kw_match(text: str, kw: str) -> bool:
    if kw.isalpha():
        return bool(re.search(rf"\b{re.escape(kw)}\b", text))
    return kw in text


def detect_mode(text: str) -> str | None:
    """Klasifikasi mood/topik pesan jadi mode (mesra/jorok/kasar/sopan)."""
    t = (text or "").lower()
    for mode, kws in _MODE_KEYWORDS:
        for kw in kws:
            if _kw_match(t, kw):
                return mode
    return None


# ── ekstraksi kata kunci (buat topik & mode baru otomatis) ───────────────────
_STOPWORDS = {
    "yang", "dan", "itu", "ini", "gua", "gue", "lu", "lo", "aku", "kamu", "saya",
    "anda", "dia", "mereka", "kita", "kami", "nggak", "gak", "ga", "enggak",
    "tidak", "iya", "ya", "aja", "saja", "udah", "sudah", "mau", "bisa", "ada",
    "kok", "sih", "deh", "dong", "kan", "lah", "nih", "tuh", "eh", "bro", "bg",
    "bang", "kak", "bu", "pak", "juga", "lagi", "dulu", "bareng", "sama",
    "kayak", "gitu", "gini", "emang", "memang", "jadi", "bikin", "buat", "malah",
    "the", "and", "you", "i", "me", "my", "is", "are", "what", "with", "for",
}


def _extract_keywords(text: str, min_len: int = 3) -> list[str]:
    """Ambil kata-kata kunci (non-stopword) dari teks."""
    return [
        w for w in re.findall(rf"[a-z]{{{min_len},}}", (text or "").lower())
        if w not in _STOPWORDS
    ]


class AutoReply:
    def __init__(self) -> None:
        self.enabled = config.ai_enabled_default
        self.blacklist: set[str] = set()
        self.memory: list[str] = []
        self.corpus: list[dict] = []
        # konteks percakapan terakhir per chat (chat_id -> deque {role, content})
        self.chat_history: dict[str, deque] = {}
        self._lock = asyncio.Lock()
        # epoch — auto-reply dijeda sampai waktu ini kalau semua provider rate-limited
        self._cooldown_until = 0.0
        # pembelajaran otomatis: mode baru (kata pemicu) & topik per chat
        self.learned_modes: dict[str, dict[str, int]] = {}
        self.topics: dict[str, dict[str, int]] = {}
        self._dirty = False
        self._autosave_task = None

    # ── state ────────────────────────────────────────────────────────────────
    async def init(self) -> None:
        try:
            if STATE_PATH.exists():
                d = json.loads(STATE_PATH.read_text(encoding="utf-8"))
                self.enabled = bool(d.get("enabled", self.enabled))
                self.blacklist = {str(x) for x in (d.get("blacklist") or [])}
                self.memory = [str(x) for x in (d.get("memory") or [])]
                self.corpus = [c for c in (d.get("corpus") or []) if c.get("text")]
                lm = d.get("learned_modes") or {}
                self.learned_modes = {
                    str(m): {str(k): int(v) for k, v in (kv or {}).items() if int(v) >= 1}
                    for m, kv in lm.items()
                }
                self.topics = {
                    str(k): {str(w): int(n) for w, n in (v or {}).items()}
                    for k, v in (d.get("topics") or {}).items()
                }
            logger.info(
                "AI auto-reply dimuat: enabled=%s, corpus=%s, memory=%s, mode_baru=%s, topik_chat=%s",
                self.enabled,
                len(self.corpus),
                len(self.memory),
                sum(len(v) for v in self.learned_modes.values()),
                len(self.topics),
            )
            self._autosave_task = asyncio.create_task(self._autosave_loop())
        except Exception as e:
            logger.warning("gagal muat ai-state: %s", e)

    async def _save(self) -> None:
        try:
            STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "enabled": self.enabled,
                "blacklist": sorted(self.blacklist),
                "memory": self.memory[-config.ai_max_memory :],
                "corpus": self.corpus[-config.ai_max_history :],
                "learned_modes": self.learned_modes,
                "topics": self.topics,
            }
            STATE_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            self._dirty = False
        except Exception as e:
            logger.warning("gagal simpan ai-state: %s", e)

    async def _autosave_loop(self) -> None:
        """Simpan otomatis tiap 20 detik kalau ada perubahan (frasa/topik/mode baru)."""
        while True:
            await asyncio.sleep(20)
            if self._dirty:
                await self._save()

    def is_enabled(self) -> bool:
        return self.enabled

    def is_configured(self) -> bool:
        return config.ai_configured

    async def set_enabled(self, v: bool) -> None:
        self.enabled = v
        await self._save()

    # ── blacklist ────────────────────────────────────────────────────────────
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

    # ── belajar gaya (korpus) ────────────────────────────────────────────────
    def _learn(self, text: str, from_me: bool, chat_id) -> None:
        text = (text or "").strip()
        if len(text) < 2 or len(text) > 2000:
            return
        if text.startswith("/"):
            return  # jangan pelajari command bot (mis. /stop /search /next)
        self.corpus.append(
            {"text": text, "fromMe": bool(from_me), "chat": str(chat_id), "ts": int(time.time())}
        )
        if len(self.corpus) > config.ai_max_history:
            self.corpus = self.corpus[-config.ai_max_history :]
        self._dirty = True
        self._track_topics(chat_id, text)

    def learn_one(self, text: str, from_me: bool, chat_id) -> None:
        self._learn(text, from_me, chat_id)

    def learn_many(self, items: list[dict]) -> None:
        for it in items:
            self._learn(it.get("text", ""), bool(it.get("fromMe")), it.get("chat", ""))

    async def clear(self) -> None:
        self.corpus = []
        await self._save()

    def stats(self) -> dict:
        mine = sum(1 for c in self.corpus if c["fromMe"])
        return {"total": len(self.corpus), "mine": mine, "theirs": len(self.corpus) - mine}

    def style_samples(self, limit: int = 10) -> list[str]:
        mine = [c["text"] for c in self.corpus if c["fromMe"]][-limit:]
        theirs = [c["text"] for c in self.corpus if not c["fromMe"]][-limit:]
        return mine + theirs

    # ── memori ───────────────────────────────────────────────────────────────
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
            if len(self.memory) > config.ai_max_memory:
                self.memory = self.memory[-config.ai_max_memory :]
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

    # ── tool executor ────────────────────────────────────────────────────────
    def _tool_schemas(self) -> list[dict]:
        out: list[dict] = []
        if config.ai_tools:
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": "get_time",
                        "description": "Waktu/tanggal sekarang (WIB)",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            )
            out.append(
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
                }
            )
            out.append(
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
                }
            )
            out.append(
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
                }
            )
        if config.ai_tools and config.ai_web_search:
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": "search_web",
                        "description": "Cari info faktual terkini di web",
                        "parameters": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                            "required": ["query"],
                        },
                    },
                }
            )
        if config.ai_tools and config.ai_weather:
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": "get_weather",
                        "description": "Cuaca terkini sebuah kota",
                        "parameters": {
                            "type": "object",
                            "properties": {"city": {"type": "string"}},
                            "required": ["city"],
                        },
                    },
                }
            )
        if config.ai_tools and config.ai_currency:
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": "convert_currency",
                        "description": "Konversi mata uang (mis. USD ke IDR)",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "amount": {"type": "number"},
                                "from": {"type": "string"},
                                "to": {"type": "string"},
                            },
                            "required": ["amount", "from", "to"],
                        },
                    },
                }
            )
        return out

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
            if name == "search_web":
                return await search_web(str(args.get("query", "")))
            if name == "get_weather":
                return await get_weather(str(args.get("city", "")))
            if name == "convert_currency":
                return await convert_currency(
                    float(args.get("amount", 0)),
                    str(args.get("from", "")),
                    str(args.get("to", "")),
                )
            return "tool tidak dikenal"
        except Exception as e:
            return f"tool error: {e}"

    # ── panggilan LLM ────────────────────────────────────────────────────────
    def _headers(self, provider: dict) -> dict:
        h = {"Content-Type": "application/json"}
        if provider["api_key"]:
            h["Authorization"] = f"Bearer {provider['api_key']}"
        return h

    async def _call(self, provider: dict, messages: list[dict], tools: list[dict]) -> str | None:
        """Satu provider, termasuk loop tool-calling. Return teks balasan atau None."""
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
            # jalankan tools lalu lanjutkan percakapan
            messages.append(msg)
            for tc in tool_calls:
                fn = tc.get("function") or {}
                args = {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    pass
                result = await self._run_tool(fn.get("name", ""), args)
                messages.append(
                    {"role": "tool", "tool_call_id": tc.get("id", ""), "content": result}
                )
            body = {"model": provider["model"], "messages": messages, "temperature": 0.7}
        return None

    async def _complete(self, messages: list[dict], tools: list[dict]) -> str | None:
        """Coba provider berurutan (primary → fallback → Ollama)."""
        last_err = "tidak ada provider"
        rate_limited = False
        for provider in config.providers:
            try:
                reply = await self._call(provider, messages, tools)
                if reply:
                    return reply
            except RateLimitError as e:
                rate_limited = True
                last_err = str(e)
                logger.debug("provider %s rate-limited", provider["name"])
                await asyncio.sleep(1.5)  # jeda biar nggak ngehajar provider
                continue
            except Exception as e:
                last_err = str(e)
                logger.warning("provider %s gagal: %s", provider["name"], e)
                continue
        if rate_limited:
            self._cooldown_until = time.time() + config.ai_cooldown_seconds
            logger.warning(
                "semua provider rate-limited → auto-reply dijeda %ss",
                config.ai_cooldown_seconds,
            )
        else:
            logger.error("semua provider gagal: %s", last_err)
        return None

    # ── prompt & konteks ─────────────────────────────────────────────────────
    def _style_text(self, chat_id) -> str:
        """Cuma contoh gaya milik akun (bukan lawan bicara) biar nggak ketularan gayanya dia."""
        chat = str(chat_id)
        mine = [c["text"] for c in self.corpus if c["fromMe"] and c["chat"] == chat][-20:]
        if not mine:
            mine = [c["text"] for c in self.corpus if c["fromMe"]][-20:]
        if not mine:
            return ""
        return "contoh gaya chat kamu:\n" + "\n".join(f"- {t}" for t in mine)

    def _track_topics(self, chat_id, text: str) -> None:
        """Hitung kata kunci per chat (buat 'topik yang sering dibahas')."""
        key = str(chat_id)
        counter = self.topics.setdefault(key, {})
        for w in _extract_keywords(text):
            counter[w] = counter.get(w, 0) + 1
        if len(counter) > 200:
            top = sorted(counter.items(), key=lambda x: -x[1])[:150]
            self.topics[key] = dict(top)

    def _chat_topics(self, chat_id, limit: int = 8) -> list[str]:
        counter = self.topics.get(str(chat_id), {})
        return [w for w, _ in sorted(counter.items(), key=lambda x: -x[1])[:limit]]

    def _learn_mode_words(self, mode: str, text: str) -> None:
        """Belajar kata pemicu mode baru dari pesan yang masuk (otomatis)."""
        base = {w for _, kws in _MODE_KEYWORDS for w in kws}
        counter = self.learned_modes.setdefault(mode, {})
        for w in _extract_keywords(text, min_len=4):
            if w in base:
                continue
            counter[w] = counter.get(w, 0) + 1
        if len(counter) > 100:
            top = sorted(counter.items(), key=lambda x: -x[1])[:80]
            self.learned_modes[mode] = dict(top)

    def _mode_from_learned(self, text: str) -> str | None:
        """Cek mode dari kata pemicu yang sudah dipelajari."""
        t = (text or "").lower()
        best, best_c = None, 0
        for mode, counter in self.learned_modes.items():
            for kw, cnt in counter.items():
                if cnt >= config.ai_mode_learn_threshold and _kw_match(t, kw) and cnt > best_c:
                    best, best_c = mode, cnt
        return best

    def _detect_mode(self, chat_id, content: str) -> str | None:
        """Cari mode dari pesan terbaru + beberapa pesan user terakhir (biar mode nempel)."""
        texts = [content]
        for m in self._recent(chat_id):
            if m.get("role") == "user":
                texts.append(m.get("content", ""))
        for t in texts[:5]:
            mode = detect_mode(t) or self._mode_from_learned(t)
            if mode:
                return mode
        return None

    def detect_mode(self, chat_id, content: str) -> str | None:
        """Public: deteksi mode chat (dipakai main.py buat pilih sticker)."""
        return self._detect_mode(chat_id, content)

    def _system(self, name: str, chat_id, mode: str | None = None) -> str:
        sys = config.ai_system_prompt.replace("{name}", name) if config.ai_system_prompt else SYSTEM_BASE
        sys += f"\nNama akun: {name}."
        style = self._style_text(chat_id)
        if style:
            sys += "\n\nGaya bahasa yang harus ditiru:\n" + style
        if self.memory:
            sys += "\n\nFakta yang kamu ingat soal user:\n" + "\n".join(f"- {m}" for m in self.memory[-30:])
        if mode and mode in _MODE_HINTS:
            sys += "\n\n" + _MODE_HINTS[mode]
        topics = self._chat_topics(chat_id)
        if topics:
            sys += "\n\nTopik yang sering dibahas di chat ini: " + ", ".join(topics) + "."
        sys += (
            "\n\nJawab singkat & natural, jangan sebut bahwa kamu AI. "
            "Sesuaikan nada dengan topik/mood lawan bicara. "
            "Balas pesan terakhir user, jangan menceritakan ulang chat lama. "
            "Gunakan tool kalau perlu (waktu, hitung, cari web, cuaca, kurs)."
        )
        return sys

    def _recent(self, chat_id) -> list[dict]:
        return list(self.chat_history.get(str(chat_id), []))

    def _push_history(self, chat_id, role: str, content: str) -> None:
        key = str(chat_id)
        q = self.chat_history.setdefault(key, deque(maxlen=config.ai_context_limit))
        q.append({"role": role, "content": content})

    def seed_context(self, chat_id, turns: list[dict]) -> None:
        """Isi konteks percakapan dari riwayat (urutan kronologis, paling lama → terbaru)."""
        if not turns:
            return
        key = str(chat_id)
        q = self.chat_history.setdefault(key, deque(maxlen=config.ai_context_limit))
        q.clear()
        for t in turns[-config.ai_context_limit :]:
            q.append({"role": t.get("role", "user"), "content": t.get("content", "")})

    # ── pipeline utama ───────────────────────────────────────────────────────
    async def handle(
        self,
        chat_id,
        name: str,
        text: str | None = None,
        media_kind: str | None = None,
        voice_text: str | None = None,
        replied_to_me: bool = False,
    ) -> str | None:
        """Balas otomatis. Return teks balasan atau None (skip)."""
        if not self.enabled:
            return None
        if time.time() < self._cooldown_until:
            return None  # lagi cooldown (semua provider rate-limited)
        if self.is_blacklisted(chat_id):
            return None

        content = (text or voice_text or "").strip()
        if not content:
            if media_kind == "sticker" and config.ai_reply_to_stickers:
                content = "(stiker)"
            elif media_kind in ("photo", "video", "voice") and config.ai_reply_to_media:
                content = {
                    "photo": "(foto tanpa caption)",
                    "video": "(video tanpa caption)",
                    "voice": "(voice note — transkripsi gagal)",
                }[media_kind]
            else:
                return None
        if len(content) > 4000:
            content = content[:4000]

        mode = self._detect_mode(chat_id, content)
        if mode:
            self._learn_mode_words(mode, content)
        async with self._lock:
            messages = [{"role": "system", "content": self._system(name, chat_id, mode)}]
            for m in self._recent(chat_id):
                messages.append(m)
            messages.append({"role": "user", "content": content})

            tools = self._tool_schemas() if config.ai_tools else []
            reply = await self._complete(messages, tools)
            if not reply:
                return None
            if reply.lstrip().startswith("/"):
                logger.warning("balasan berupa command (/) → dilewati (cegah loop bot)")
                return None

            # anti-pengulangan: kalau jawaban mirip dgn balasan terakhir, coba variasikan sekali
            prev_replies = [m["content"] for m in self._recent(chat_id) if m.get("role") == "assistant"]
            if any(_similarity(r, reply) >= 0.6 for r in prev_replies[-3:]):
                retry = messages + [
                    {"role": "assistant", "content": reply},
                    {"role": "user", "content": "Jawabanmu barusan mirip banget sama yang sebelumnya. Jawab dengan cara yang benar-benar beda & natural."},
                ]
                alt = await self._complete(retry, [])
                if alt and not any(_similarity(r, alt) >= 0.6 for r in prev_replies[-3:]):
                    reply = alt
                else:
                    return None  # masih ngulang juga → mending diem daripada spam

            self._push_history(chat_id, "user", content)
            self._push_history(chat_id, "assistant", reply)
            return reply

    async def test(self, text: str) -> str | None:
        return await self.handle("__test__", "kamu", text=text)

    # ── gaya dipaksa baku saat akan diucapkan (anti-medok) ───────────────────
    async def _spoken_variant(self, text: str) -> str:
        """Bikin teks lebih 'baku' supaya enak dibaca TTS."""
        sys = (
            "Ubah kalimat berikut jadi bahasa Indonesia yang natural & jelas untuk dibacakan "
            "(bukan slang/Jawa/gaul berlebihan). Pertahankan makna. Cuma keluarkan hasilnya."
        )
        reply = await self._complete(
            [{"role": "system", "content": sys}, {"role": "user", "content": text}], []
        )
        return (reply or text).strip()


ai = AutoReply()
