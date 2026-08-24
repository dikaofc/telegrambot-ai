# ============================================================
# CONFIG — GANTI INI!
# ============================================================

# Telegram (wajib) - dari https://my.telegram.org
TELEGRAM_API_ID = 12345678                # Ganti dari https://my.telegram.org
TELEGRAM_API_HASH = "your_api_hash_here"   # Ganti!
TELEGRAM_PHONE = "+628xxxxxxxxxxx"          # Ganti!

# Upstash Redis
UPSTASH_REDIS_URL = "https://your-db.upstash.io"   # Ganti dari upstash.com
UPSTASH_REDIS_TOKEN = "your_upstash_token_here"     # Ganti!

# Berapa banyak pesan per chat yang mau di-scrape (max)
MAX_MESSAGES_PER_CHAT = 500

# Nama key di Upstash
TRAINING_KEY = "telegram:training_data"
PROFILE_KEY = "telegram:chat_profile"
STATS_KEY = "telegram:scrape_stats"