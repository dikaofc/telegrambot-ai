import json
import redis

# Fix: pakai from_url() karena versi redis di Colab gak support parameter url= langsung
r = redis.Redis.from_url(
    UPSTASH_REDIS_URL,
    token=UPSTASH_REDIS_TOKEN,
    decode_responses=True,
)

# Upload training data (chunked biar nggak timeout)
CHUNK_SIZE = 100
all_keys = []

for i in range(0, len(training_data), CHUNK_SIZE):
    chunk = training_data[i:i + CHUNK_SIZE]
    chunk_key = f"{TRAINING_KEY}:chunk:{i // CHUNK_SIZE}"
    r.set(chunk_key, json.dumps(chunk, ensure_ascii=False))
    all_keys.append(chunk_key)

# Simpan index chunk
r.set(f"{TRAINING_KEY}:index", json.dumps(all_keys))
r.set(f"{TRAINING_KEY}:total", str(len(training_data)))

# Upload chat profile (buat system prompt)
my_name = me.first_name or "User"
r.set(PROFILE_KEY, json.dumps({
    "name": my_name,
    "username": me.username or "",
    "user_id": me.id,
    "scraped_at": datetime.now(WIB).isoformat(),
    "total_messages": len(training_data),
    "chats": chat_stats,
}, ensure_ascii=False))

# Upload stats
r.set(STATS_KEY, json.dumps({
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
