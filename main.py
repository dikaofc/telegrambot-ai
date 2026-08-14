"""Userbot Telegram AI otomatis (Telethon) — auto-reply, belajar gaya, memori, tools, voice."""

import asyncio
import sys
import time

from telethon import TelegramClient, events

import stickers
import stt
import tts
from ai import ai
from config import config
from logger import logger

COMMANDS = {
    "help": "daftar command",
    "ping": "cek bot hidup",
    "me": "lihat ID akun kamu (buat set OWNER_ID)",
    "ai": ".ai on|off|status — on/off auto-reply",
    "aitrain": "statistik korpus gaya",
    "aistyle": "contoh gaya yang dipelajari",
    "aiclear": "hapus semua korpus gaya",
    "mem": ".mem [fakta] — lihat/simpan memori",
    "memclear": "hapus semua memori",
    "bl": ".bl [id] — blacklist (tanpa arg = list)",
    "unbl": ".unbl id — hapus dari blacklist",
    "aitest": ".aitest <teks> — tes balasan AI",
    "sticker": ".sticker on|off|always — balas pakai sticker",
}

client = TelegramClient(config.session_name, config.api_id, config.api_hash)
ME = None
_last_msg_ts: dict[str, float] = {}
BURST_WINDOW = 4.0  # detik — pesan beruntun dalam jendela ini dianggap "tumpuk"
_sticker_mode = config.ai_reply_sticker  # off | sticker | always


# ── helpers ──────────────────────────────────────────────────────────────────


def is_owner(event) -> bool:
    if config.owner_id and event.sender_id == config.owner_id:
        return True
    if config.owner_username:
        sender = event.sender
        uname = getattr(sender, "username", None)
        if uname and uname.lower() == config.owner_username.lower():
            return True
    # belum dikonfigurasi → izinkan semua (dev), tapi sudah di-warning di log
    if not config.owner_id and not config.owner_username:
        return True
    return False


def media_kind(msg):
    if msg.voice or (msg.audio and getattr(msg.audio, "voice", False)):
        return "voice"
    if msg.sticker:
        return "sticker"
    if msg.photo:
        return "photo"
    if msg.video or msg.video_note:
        return "video"
    return None


def chat_key(event) -> str:
    return str(event.chat_id or event.sender_id or 0)


def _is_stacked(chat_id: str, now: float) -> bool:
    """True kalau pesan ini datang beruntun (burst) — buat mutusin quote/normal."""
    prev = _last_msg_ts.get(chat_id)
    _last_msg_ts[chat_id] = now
    return prev is not None and (now - prev) <= BURST_WINDOW


async def sender_name(event) -> str:
    sender = event.sender
    if not sender:
        try:
            sender = await event.get_sender()
        except Exception:
            sender = None
    if sender:
        first = getattr(sender, "first_name", None) or ""
        last = getattr(sender, "last_name", None) or ""
        name = " ".join(x for x in (first, last) if x).strip()
        if name:
            return name
        if getattr(sender, "username", None):
            return sender.username
    return str(event.sender_id or "kamu")


def should_voice(kind) -> bool:
    if config.ai_reply_voice == "always":
        return True
    if config.ai_reply_voice == "voice" and kind == "voice":
        return True
    return False


def _sticker_enabled() -> bool:
    return _sticker_mode in ("sticker", "always")


def _msg_sticker_emoji(msg) -> str | None:
    st = getattr(msg, "sticker", None)
    if st and getattr(st, "alt", None):
        return st.alt
    return None


async def _send_sticker(event, emojis, stacked) -> bool:
    doc = stickers.pick_sticker(emojis)
    if not doc:
        return False
    try:
        if stacked:
            await event.reply(file=doc)
        else:
            await event.respond(file=doc)
        return True
    except Exception as e:
        logger.warning("kirim sticker gagal: %s", e)
        return False


# ── voice ────────────────────────────────────────────────────────────────────


async def handle_voice(event) -> str | None:
    if not config.stt_api_key:
        logger.info("voice note diterima tapi STT_API_KEY kosong → dilewati")
        return None
    try:
        data = await client.download_media(event.message, file=bytes)
    except Exception as e:
        logger.warning("unduh voice gagal: %s", e)
        return None
    if not data:
        logger.warning("unduh voice note kosong")
        return None
    text = await stt.transcribe(data)
    if not text:
        logger.warning("transkripsi voice note gagal/kosong (cek kuota Groq Whisper)")
    return text or None


# ── command ──────────────────────────────────────────────────────────────────


async def handle_command(event, text: str):
    parts = text.split(None, 1)
    cmd = parts[0].lstrip(".").lower()
    arg = parts[1].strip() if len(parts) > 1 else ""

    async def reply(s: str):
        await event.reply(s)

    if cmd in ("help", "menu"):
        lines = ["Command tersedia:"]
        for k, v in COMMANDS.items():
            lines.append(f"• .{k} — {v}")
        return await reply("\n".join(lines))

    if cmd == "ping":
        return await reply("pong 🏓")

    if cmd in ("me", "id", "info"):
        me = await client.get_me()
        return await reply(f"ID kamu: {me.id}\nUsername: @{me.username or '-'}")

    if cmd == "ai":
        if arg.lower() in ("on", "1", "true"):
            await ai.set_enabled(True)
            return await reply("Auto-reply AI: ON")
        if arg.lower() in ("off", "0", "false"):
            await ai.set_enabled(False)
            return await reply("Auto-reply AI: OFF")
        return await reply(
            f"Auto-reply AI: {'ON' if ai.is_enabled() else 'OFF'}\n"
            f"Provider: {len(config.providers)}\n"
            f"Terpasang: {'ya' if ai.is_configured() else 'tidak'}"
        )

    if cmd == "aitrain":
        s = ai.stats()
        return await reply(
            f"Korpus gaya: {s['total']} pesan ({s['mine']} milikku, {s['theirs']} lawan bicara)"
        )

    if cmd == "aistyle":
        samples = ai.style_samples(12)
        if not samples:
            return await reply("Belum ada korpus gaya.")
        return await reply("Contoh gaya yang dipelajari:\n" + "\n".join(f"• {t}" for t in samples))

    if cmd == "aiclear":
        await ai.clear()
        return await reply("Korpus gaya dihapus.")

    if cmd == "mem":
        if arg:
            res = await ai.remember(arg)
            return await reply(f"Memori: {res}")
        mem = ai.list_memory()
        if not mem:
            return await reply("Memori kosong.")
        return await reply("Memori:\n" + "\n".join(f"• {m}" for m in mem))

    if cmd == "memclear":
        await ai.clear_memory()
        return await reply("Memori dihapus.")

    if cmd == "bl":
        if not arg:
            bl = ai.list_blacklist()
            if not bl:
                return await reply("Blacklist kosong.")
            return await reply("Blacklist:\n" + "\n".join(f"• {x}" for x in bl))
        ident, added = await ai.add_to_blacklist(arg)
        return await reply(f"{'Ditambah' if added else 'Sudah ada'} di blacklist: {ident}")

    if cmd == "unbl":
        if not arg:
            return await reply("Usage: .unbl <id>")
        ident, removed = await ai.remove_from_blacklist(arg)
        return await reply(f"{'Dihapus' if removed else 'Tidak ada'} dari blacklist: {ident}")

    if cmd == "aitest":
        if not arg:
            return await reply("Usage: .aitest <teks>")
        r = await ai.test(arg)
        return await reply(r or "(tidak ada balasan — cek provider)")

    if cmd == "sticker":
        global _sticker_mode
        if arg.lower() in ("on", "1", "true", "sticker"):
            _sticker_mode = "sticker"
            return await reply(f"Balas sticker: ON (sticker↔sticker). Sticker termuat: {stickers.count()}")
        if arg.lower() == "always":
            _sticker_mode = "always"
            return await reply(f"Balas sticker: ALWAYS (tiap balasan + sticker). Sticker: {stickers.count()}")
        if arg.lower() in ("off", "0", "false"):
            _sticker_mode = "off"
            return await reply("Balas sticker: OFF")
        return await reply(
            f"Balas sticker: {_sticker_mode}. Sticker termuat: {stickers.count()}\n"
            f"Gunakan: .sticker on | off | always"
        )


# ── handlers ─────────────────────────────────────────────────────────────────


@client.on(events.NewMessage(incoming=True))
async def on_incoming(event):
    global ME
    if not event.message or event.out:
        return
    # jangan balas / pelajari pesan dari BOT (cegah loop kayak anonymous chat bot)
    sender = event.sender
    if sender is None:
        try:
            sender = await event.get_sender()
        except Exception:
            sender = None
    if sender is not None and getattr(sender, "bot", False):
        return
    # abaikan channel/broadcast
    if event.is_channel and not event.is_group:
        return

    msg = event.message
    text = (msg.text or "").strip()

    # deteksi chat "tumpuk" (pesan beruntun) → nanti pakai quote kalau rame
    stacked = _is_stacked(chat_key(event), time.time())

    # command dari owner
    if text.startswith(".") and is_owner(event):
        try:
            await handle_command(event, text)
        except Exception as e:
            logger.warning("command error: %s", e)
        return

    # belajar dari pesan masuk (teks biasa)
    if text and not text.startswith("."):
        ai.learn_one(text, False, chat_key(event))

    # grup: cuma balas kalau diizinkan & di-mention/di-reply
    replied_to_me = False
    if event.is_group:
        if not config.ai_reply_in_groups:
            return
        if ME is None:
            ME = await client.get_me()
        replied_to_me = bool(msg.reply_to) and (msg.reply_to.sender_id == ME.id)
        mentioned = bool(msg.mentioned) or (
            ME.username and ("@" + ME.username).lower() in text.lower()
        )
        if not (mentioned or replied_to_me):
            return

    kind = media_kind(msg)

    # balas sticker pakai sticker dari koleksi userbot
    if kind == "sticker" and _sticker_enabled():
        emoji = _msg_sticker_emoji(msg)
        if await _send_sticker(event, [emoji] if emoji else None, stacked):
            return

    voice_text = None
    if kind == "voice":
        voice_text = await handle_voice(event)
        if voice_text:
            ai.learn_one(voice_text, False, chat_key(event))

    name = await sender_name(event)
    reply = await ai.handle(
        chat_key(event),
        name,
        text=text or None,
        media_kind=kind,
        voice_text=voice_text,
        replied_to_me=replied_to_me,
    )
    if not reply:
        return

    if should_voice(kind):
        spoken = await ai._spoken_variant(reply)
        audio = await tts.synthesize(spoken)
        if audio:
            try:
                if stacked:
                    await event.reply(file=audio, voice_note=True)
                else:
                    await event.respond(file=audio, voice_note=True)
                return
            except Exception as e:
                logger.warning("kirim voice gagal: %s", e)
    # normal: kirim biasa (bukan quote); kalau chat lagi rame/tumpuk, baru quote
    if stacked:
        await event.reply(reply)
    else:
        await event.respond(reply)

    # mode always: sertakan sticker yang nyambung sama mood chat
    if _sticker_mode == "always":
        mode = ai.detect_mode(chat_key(event), text or voice_text or "")
        emojis = stickers.MODE_EMOJIS.get(mode) or stickers.MODE_EMOJIS["normal"]
        await _send_sticker(event, emojis, stacked)


@client.on(events.NewMessage(outgoing=True))
async def on_outgoing(event):
    if not event.message:
        return
    text = (event.message.text or "").strip()
    if text and not text.startswith("."):
        ai.learn_one(text, True, chat_key(event))


# ── bootstrap riwayat ────────────────────────────────────────────────────────


async def bootstrap_history():
    """Baca N pesan terakhir tiap dialog buat seed gaya & konteks sebelum balas."""
    if not config.ai_bootstrap:
        return
    logger.info(
        "memuat riwayat chat (bootstrap) — sampai %d dialog × %d pesan ...",
        config.ai_bootstrap_dialogs,
        config.ai_bootstrap_messages,
    )
    done = 0
    try:
        async for dialog in client.iter_dialogs(limit=config.ai_bootstrap_dialogs):
            if dialog.entity is not None and getattr(dialog.entity, "bot", False):
                continue  # skip dialog bot (jangan pelajari pesan bot)
            entity = dialog.entity or dialog.id
            chat_id = str(dialog.id)
            turns: list[dict] = []
            try:
                async for m in client.iter_messages(entity, limit=config.ai_bootstrap_messages):
                    txt = (m.text or "").strip()
                    if not txt:
                        continue
                    from_me = bool(m.out) or (ME is not None and m.sender_id == ME.id)
                    ai.learn_one(txt, from_me, chat_id)
                    turns.append({"role": "assistant" if from_me else "user", "content": txt})
            except Exception as e:
                logger.debug("gagal baca dialog %s: %s", chat_id, e)
            turns.reverse()  # iter_messages newest-first → jadikan kronologis
            ai.seed_context(chat_id, turns)
            done += 1
            if done % 5 == 0:
                logger.info("bootstrap progres: %d dialog, korpus %d pesan", done, ai.stats()["total"])
    except Exception as e:
        logger.warning("bootstrap error: %s", e)
    logger.info("bootstrap selesai: %d dialog terbaca, korpus %d pesan", done, ai.stats()["total"])


# ── main ─────────────────────────────────────────────────────────────────────


async def main():
    global ME
    await ai.init()
    if not config.api_id or not config.api_hash:
        logger.error("API_ID / API_HASH belum diisi di .env (dapatkan di my.telegram.org)")
        sys.exit(1)
    logger.info("menyambungkan Telethon (api_id=%s)...", config.api_id)
    await client.start(phone=config.phone)
    ME = await client.get_me()
    logger.info("login sebagai @%s (id=%s)", ME.username or "-", ME.id)
    if not config.owner_id and not config.owner_username:
        logger.warning(
            "OWNER_ID belum diset — command .* terbuka untuk semua. Set OWNER_ID=%s di .env",
            ME.id,
        )
    await bootstrap_history()
    await stickers.load_stickers(client)
    logger.info("userbot aktif. kirim .help untuk daftar command")
    await client.run_until_disconnected()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("berhenti.")
        sys.exit(0)
