import json
import httpx

UPSTASH_HEADERS = {
    "Authorization": f"Bearer {UPSTASH_REDIS_TOKEN}",
}

def upstash_get(key):
    """GET a key dari Upstash."""
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
