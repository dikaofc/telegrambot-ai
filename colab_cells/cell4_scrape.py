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
print(f"   🔨 Mulai scrape (private duluan)...\n")

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
