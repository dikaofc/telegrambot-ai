import json
import httpx

# Upstash REST API — pakai httpx langsung, gak perlu package tambahan
UPSTASH_HEADERS = {
    "Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}",
    "Content-Type": "application/json",
}

def upstash_set(key, value):
    """SET a key di Upstash."""
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
