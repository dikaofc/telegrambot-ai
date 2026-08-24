# ============================================================
# GOOGLE COLAB NOTEBOOK — SCRAPE TELEGRAM CHAT → UPLOAD UPSTASH
# ============================================================
# Copy-paste tiap section ke cell terpisah di Google Colab.
# Jalankan dari atas ke bawah.
# ============================================================


# ============================================================
# CELL 1: INSTALL DEPENDENCIES
# ============================================================
# !pip install telethon upstash-redis


# ============================================================
# CELL 2: CONFIG — GANTI INI!
# ============================================================

# Telegram (wajib) - dari https://my.telegram.org
TELEGRAM_API_ID = 12345678                # Ganti dari https://my.telegram.org
TELEGRAM_API_HASH = "your_api_hash_here"   # Ganti!
TELEGRAM_PHONE = "+628xxxxxxxxxxx"          # Ganti!

# Upstash Redis (WAJIB biar bot baca data!)
UPSTASH_REDIS_URL = "https://your-db.upstash.io"   # Ganti dari upstash.com
UPSTASH_REDIS_TOKEN = "your_upstash_token_here"     # Ganti!

# Berapa banyak pesan per chat yang mau di-scrape (max)
MAX_MESSAGES_PER_CHAT = 1000

# Nama key di Upstash (jangan diubah kecuali lu tahu apa yg dilakukan)
TRAINING_KEY = "telegram:training_data"
PROFILE_KEY = "telegram:chat_profile"
STATS_KEY = "telegram:scrape_stats"


# ============================================================
# CELL 3: CONNECT TELEGRAM
# ============================================================
from telethon import TelegramClient

client = TelegramClient("colab_session", TELEGRAM_API_ID, TELEGRAM_API_HASH)
await client.start(phone=TELEGRAM_PHONE)

me = await client.get_me()
print(f"✅ Login sebagai: {me.first_name} (@{me.username}) ID: {me.id}")


# ============================================================
# CELL 4: SCRAPE CHAT HISTORY
# ============================================================
import asyncio
import json
import time
from datetime import datetime, timezone, timedelta

WIB = timezone(timedelta(hours=7))

training_data = []
chat_stats = {}
skipped_bots = 0
skipped_empty = 0

# ── Kumpulkan semua dialog dulu, lalu sort: private → group → channel ──
print("📡 Mengumpulkan daftar chat...")
all_dialogs = []
async for dialog in client.iter_dialogs(limit=200):
    if dialog.entity and getattr(dialog.entity, "bot", False):
        skipped_bots += 1
        continue
    all_dialogs.append(dialog)

# Prioritas: private (1) > group (2) > channel (3)
def dialog_priority(d):
    if d.is_user and not (d.entity and getattr(d.entity, "bot", False)):
        return 1  # private chat
    if d.is_group:
        return 2  # group
    if d.is_channel:
        return 3  # channel
    return 4

all_dialogs.sort(key=dialog_priority)

private_count = sum(1 for d in all_dialogs if dialog_priority(d) == 1)
group_count = sum(1 for d in all_dialogs if dialog_priority(d) == 2)
channel_count = sum(1 for d in all_dialogs if dialog_priority(d) == 3)
print(f"   📋 Ditemukan: {private_count} private, {group_count} group, {channel_count} channel")
print(f"   🔨 Mulai scrape (private duluan)...")

# ── Scrape per urutan prioritas ──
for dialog in all_dialogs:
    chat_id = str(dialog.id)
    chat_name = getattr(dialog, "name", None) or dialog.title or f"Chat_{dialog.id}"

    # Label tipe chat
    if dialog_priority(dialog) == 1:
        label = "👤"
    elif dialog_priority(dialog) == 2:
        label = "👥"
    else:
        label = "📢"

    count = 0
    try:
        async for msg in client.iter_messages(dialog.entity, limit=MAX_MESSAGES_PER_CHAT):
            text = (msg.text or "").strip()
            if not text or len(text) < 2:
                continue
            if text.startswith("/") or text.startswith("."):
                continue

            from_me = bool(msg.out)
            ts = msg.date.replace(tzinfo=timezone.utc).astimezone(WIB).isoformat()

            training_data.append({
                "text": text,
                "fromMe": from_me,
                "chat_id": chat_id,
                "chat_name": chat_name,
                "timestamp": ts,
                "msg_id": msg.id,
            })
            count += 1

        if count > 0:
            chat_stats[chat_name] = {
                "chat_id": chat_id,
                "type": "private" if dialog_priority(dialog) == 1 else "group" if dialog_priority(dialog) == 2 else "channel",
                "messages_scraped": count,
            }
            print(f"  {label} {chat_name}: {count} pesan")
        else:
            skipped_empty += 1

    except Exception as e:
        print(f"  ⚠️ Gagal scrape {chat_name}: {e}")

    await asyncio.sleep(0.3)

print(f"\n📊 Selesai scrape!")
print(f"   Total pesan: {len(training_data)}")
print(f"   Chat aktif: {len(chat_stats)}")
print(f"   Private: {sum(1 for v in chat_stats.values() if v['type'] == 'private')}")
print(f"   Group: {sum(1 for v in chat_stats.values() if v['type'] == 'group')}")
print(f"   Channel: {sum(1 for v in chat_stats.values() if v['type'] == 'channel')}")
print(f"   Bot di-skip: {skipped_bots}")
print(f"   Chat kosong: {skipped_empty}")


# ============================================================
# CELL 5: UPLOAD KE UPSTASH
# ============================================================
import httpx

# Upstash REST API — pakai httpx langsung, gak perlu package tambahan
UPSTASH_HEADERS = {
    "Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}",
    "Content-Type": "application/json",
}

def upstash_set(key, value):
    r = httpx.post(
        f"{UPSTASH_REDIS_URL}/set/{key}",
        headers=UPSTASH_HEADERS,
        content=value,
        timeout=30,
    )
    return r.status_code == 200

# Upload training data (chunked biar nggak timeout)
CHUNK_SIZE = 100
all_keys = []

for i in range(0, len(training_data), CHUNK_SIZE):
    chunk = training_data[i:i + CHUNK_SIZE]
    chunk_key = f"{TRAINING_KEY}:chunk:{i // CHUNK_SIZE}"
    upstash_set(chunk_key, json.dumps(chunk, ensure_ascii=False))
    all_keys.append(chunk_key)
    if (i // CHUNK_SIZE) % 10 == 0:
        print(f"  ... uploaded chunk {i // CHUNK_SIZE + 1}/{(len(training_data) + CHUNK_SIZE - 1) // CHUNK_SIZE}")

# Simpan index chunk
upstash_set(f"{TRAINING_KEY}:index", json.dumps(all_keys))
upstash_set(f"{TRAINING_KEY}:total", str(len(training_data)))

# Upload chat profile (buat system prompt)
my_name = me.first_name or "User"
upstash_set(PROFILE_KEY, json.dumps({
    "name": my_name,
    "username": me.username or "",
    "user_id": me.id,
    "scraped_at": datetime.now(WIB).isoformat(),
    "total_messages": len(training_data),
    "chats": chat_stats,
}, ensure_ascii=False))

# Upload stats
upstash_set(STATS_KEY, json.dumps({
    "total_messages": len(training_data),
    "total_chats": len(chat_stats),
    "scraped_at": datetime.now(WIB).isoformat(),
    "from_me": sum(1 for d in training_data if d["fromMe"]),
    "from_others": sum(1 for d in training_data if not d["fromMe"]),
}, ensure_ascii=False))

print(f"✅ Upload ke Upstash selesai!")
print(f"   Key: {TRAINING_KEY} ({len(all_keys)} chunks)")
print(f"   Profile: {PROFILE_KEY}")
print(f"   Stats: {STATS_KEY}")
print(f"   Total pesan: {len(training_data)}")


# ============================================================
# CELL 6: VERIFIKASI — BACA BALIK DARI UPSTASH
# ============================================================
def upstash_get(key):
    r = httpx.get(
        f"{UPSTASH_REDIS_URL}/get/{key}",
        headers=UPSTASH_HEADERS,
        timeout=30,
    )
    if r.status_code == 200:
        return r.json().get("result")
    return None

total_stored = int(upstash_get(f"{TRAINING_KEY}:total") or 0)
profile = json.loads(upstash_get(PROFILE_KEY) or "{}")
stats = json.loads(upstash_get(STATS_KEY) or "{}")

print(f"🔍 Verifikasi data di Upstash:")
print(f"   Nama: {profile.get('name')}")
print(f"   Username: @{profile.get('username')}")
print(f"   Total pesan: {total_stored}")
print(f"   Dari kamu: {stats.get('from_me', 0)}")
print(f"   Dari lawan: {stats.get('from_others', 0)}")
print(f"   Chat aktif: {stats.get('total_chats', 0)}")
print(f"   Scraped: {stats.get('scraped_at')}")

# Contoh baca chunk pertama
idx = json.loads(upstash_get(f"{TRAINING_KEY}:index") or "[]")
if idx:
    sample = json.loads(upstash_get(idx[0]) or "[]")[:5]
    print(f"\n📝 Contoh 5 pesan pertama:")
    for s in sample:
        who = "🔵 Kamu" if s["fromMe"] else "⚪ Lawan"
        print(f"   {who}: {s['text'][:80]}")

print("\n✅ Semua data sudah tersimpan di Upstash! Bot sekarang bisa baca training data.")
