import json

total_stored = int(r.get(f"{TRAINING_KEY}:total") or 0)
profile = json.loads(r.get(PROFILE_KEY) or "{}")
stats = json.loads(r.get(STATS_KEY) or "{}")

print(f"🔍 Verifikasi data di Upstash:")
print(f"   Nama: {profile.get('name')}")
print(f"   Username: @{profile.get('username')}")
print(f"   Total pesan: {total_stored}")
print(f"   Dari kamu: {stats.get('from_me', 0)}")
print(f"   Dari lawan: {stats.get('from_others', 0)}")
print(f"   Chat aktif: {stats.get('total_chats', 0)}")
print(f"   Scraped: {stats.get('scraped_at')}")

# Contoh baca chunk pertama
idx = json.loads(r.get(f"{TRAINING_KEY}:index") or "[]")
if idx:
    sample = json.loads(r.get(idx[0]) or "[]")[:5]
    print(f"\n📝 Contoh 5 pesan pertama:")
    for s in sample:
        who = "🔵 Kamu" if s["fromMe"] else "⚪ Lawan"
        print(f"   {who}: {s['text'][:80]}")

print("\n✅ Semua data sudah tersimpan di Upstash! Bot sekarang bisa baca training data.")