"""Userbot Telegram AI (Telethon) — auto-reply, training data dari Upstash, local AI."""

import asyncio
import sys
import time

from telethon import TelegramClient, events

from ai import ai
from config import config
from logger import logger

COMMANDS = {
    "help": "daftar command",
    "ping": "cek bot hidup",
    "me": "lihat ID akun kamu (buat set OWNER_ID)",
    "ai": ".ai on|off|status — on/off auto-reply",
    "train": "statistik training data",
    "mem": ".mem [fakta] — lihat/simpan memori",
    "memclear": "hapus semua memori",
    "bl": ".bl [id] — blacklist (tanpa arg = list)",
    "unbl": ".unbl id — hapus dari blacklist",
    "aitest": ".aitest <teks> — tes balasan AI",
    "reload": "reload training data dari Upstash",
}

client = TelegramClient(config.session_name, config.api_id, config.api_hash)
ME = None
_last_msg_ts: dict[str, float] = {}
BURST_WINDOW = 4.0


# ── helpers ────────────────────────────────────────────────────────────────

def is_owner(event) -> bool:
    if config.owner_id and event.sender_id == config.owner_id:
        return True
    if config.owner_username:
        sender = event.sender
        uname = getattr(sender, "username", None)
        if uname and uname.lower() == config.owner_username.lower():
            return True
    if not config.owner_id and not config.owner_username:
        return True
    return False


def chat_key(event) -> str:
    return str(event.chat_id or event.sender_id or 0)


def _is_stacked(chat_id: str, now: float) -> bool:
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


# ── command handler ────────────────────────────────────────────────────────

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
        s = ai.stats()
        return await reply(
            f"Auto-reply AI: {'ON' if ai.is_enabled() else 'OFF'}\n"
            f"Provider: {len(config.providers)}\n"
            f"Training data: {s['total']} pesan ({s['from_me']} dari kamu, {s['from_others']} dari lawan)\n"
            f"Memori: {len(ai.memory)} fakta"
        )

    if cmd == "train":
        s = ai.stats()
        return await reply(
            f"Training data:\n"
            f"• Total: {s['total']} pesan\n"
            f"• Dari kamu: {s['from_me']}\n"
            f"• Dari lawan: {s['from_others']}\n"
            f"• Nama: {s['name']}"
        )

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

    if cmd == "reload":
        await ai.training.load(force=True)
        s = ai.stats()
        return await reply(f"Training data di-reload: {s['total']} pesan dari Upstash")


# ── event handlers ─────────────────────────────────────────────────────────

@client.on(events.NewMessage(incoming=True))
async def on_incoming(event):
    global ME
    if not event.message or event.out:
        return

    # skip bot messages (cegah loop)
    sender = event.sender
    if sender is None:
        try:
            sender = await event.get_sender()
        except Exception:
            sender = None
    if sender is not None and getattr(sender, "bot", False):
        return

    # skip channel/broadcast
    if event.is_channel and not event.is_group:
        return

    msg = event.message
    text = (msg.text or "").strip()
    stacked = _is_stacked(chat_key(event), time.time())

    # command dari owner
    if text.startswith(".") and is_owner(event):
        try:
            await handle_command(event, text)
        except Exception as e:
            logger.warning("command error: %s", e)
        return

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

    name = await sender_name(event)
    reply = await ai.handle(
        chat_key(event),
        name,
        text=text or None,
        replied_to_me=replied_to_me,
    )
    if not reply:
        return

    if stacked:
        await event.reply(reply)
    else:
        await event.respond(reply)


@client.on(events.NewMessage(outgoing=True))
async def on_outgoing(event):
    # Outgoing messages — buat logging aja (training data dari Upstash)
    pass


# ── bootstrap ──────────────────────────────────────────────────────────────

async def bootstrap_training_data():
    """Load training data dari Upstash saat startup."""
    print("[1/4] memuat training data dari Upstash...")
    await ai.training.load(force=True)
    s = ai.stats()
    print(f"[1/4] training data loaded: {s['total']} pesan")


# ── main ───────────────────────────────────────────────────────────────────

async def main():
    global ME
    print("[0/4] inisialisasi AI...")
    await ai.init()
    print("[0/4] AI siap.")

    if not config.api_id or not config.api_hash:
        print("[ERROR] API_ID / API_HASH kosong! Isi di .env atau environment variables.")
        sys.exit(1)

    print(f"[2/4] menyambungkan Telethon (api_id={config.api_id})...")
    await client.start(phone=config.phone)
    ME = await client.get_me()
    print(f"[3/4] login sebagai @{ME.username or '-'} (id={ME.id})")

    if not config.owner_id and not config.owner_username:
        logger.warning(
            "OWNER_ID belum diset — command .* terbuka untuk semua. Set OWNER_ID=%s di .env",
            ME.id,
        )

    await bootstrap_training_data()
    print("[4/4] userbot aktif! kirim .help untuk daftar command.")
    await client.run_until_disconnected()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("berhenti.")
        sys.exit(0)
