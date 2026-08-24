# telegrambot-ai

Userbot Telegram (Telethon) yang membalas chat otomatis pakai AI, dengan **training data dari Upstash Redis** (di-scrape via Google Colab).

> No Ollama. No paid API. Pakai 9router (free tier) + Upstash (free tier).

## Arsitektur

```
Google Colab → Scrape Telegram Chat → Upload ke Upstash Redis
                                            ↑
Local Bot / Railway ← Read Training Data ←──┘
    ↓
9router API (auto-fallback: mimo-v2.5 → laguna-s → nemotron)
    ↓
Auto-reply di Telegram
```

## Fitur

- **Auto-reply AI** multi-model dengan auto-fallback (3 model gratis).
- **Training data dari Upstash**: scrape chat history via Colab, bot baca saat startup.
- **Belajar gaya**: AI meniru cara kamu ngetik dari training data.
- **Memori jangka panjang**: AI bisa menyimpan & mengingat fakta via tool-calling.
- **Agent tools**: waktu WIB, kalkulator aman — semua gratis tanpa key.
- **Anti-pengulangan**: deteksi jawaban mirip → otomatis variasikan.
- **Sanitasi reasoning**: chain-of-thought dibersihkan, cuma jawaban final yang muncul.

---

## Setup (Local Windows)

### 1. Install Python

Download dari https://www.python.org/downloads/ — **centang "Add Python to PATH"**.

Atau via PowerShell:
```powershell
winget install Python.Python.3.12
```

### 2. Clone & Setup

```bash
git clone <repo-url>
cd telegrambot-ai

# Windows — klik double-click:
setup.bat

# Atau manual:
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

### 3. Edit `.env`

Isi credentials:
- `API_ID` & `API_HASH` — dari https://my.telegram.org
- `PHONE` — nomor HP Telegram
- `UPSTASH_REDIS_URL` & `UPSTASH_REDIS_TOKEN` — dari https://upstash.com
- `AI_API_KEY` — sudah ada di `.env.example` (9router free)

### 4. Scrape Chat via Colab

1. Buka Google Colab
2. Copy-paste cell dari `colab_scraper.py` (atau folder `colab_cells/`)
3. Jalankan dari atas ke bawah
4. Data otomatis ter-upload ke Upstash

### 5. Jalankan

```bash
# Windows — klik double-click:
run.bat

# Atau manual:
.venv\Scripts\activate
python main.py
```

Login pertama akan diminta nomor HP + kode OTP.

---

## Deploy 24/7 ke Railway

Railway support long-running process (beda sama Vercel yang serverless).

### 1. Push ke GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin <your-repo-url>
git push -u origin main
```

### 2. Deploy di Railway

1. Buka https://railway.app → Login dengan GitHub
2. Klik **New Project** → **Deploy from GitHub Repo**
3. Pilih repo ini
4. Railway otomatis detect Dockerfile → build & deploy

### 3. Set Environment Variables

Di Railway dashboard → tab **Variables**, tambahkan:

```
API_ID=12345678
API_HASH=your_api_hash_here
PHONE=+628xxxxxxxxxxx
OWNER_ID=0
AI_BASE_URL=https://your-ai-api-url.com/v1
AI_API_KEY=your_ai_api_key_here
AI_MODEL=your_model_name
AI_FALLBACKS=fallback-1|url|model|key;fallback-2|url|model|key
UPSTASH_REDIS_URL=https://your-db.upstash.io
UPSTASH_REDIS_TOKEN=your_upstash_token_here
```

> ⚠️ Login pertama butuh OTP — Railway logs akan minta input. Klik tab **Deployments** → klik deployment terbaru → lihat logs → input nomor OTP di terminal Railway.

### 4. Login Telegram di Railway

Setelah deploy pertama, Railway akan menunggu input OTP. Caranya:

1. Tab **Deployments** → klik deployment yang running
2. Lihat logs — ada prompt minta nomor HP / kode OTP
3. Ketik nomor HP lalu Enter, lalu kode OTP lalu Enter
4. Session tersimpan di Railway (persistent disk)

> **Tip**: Setelah login pertama berhasil, session tersimpan. Deploy selanjutnya langsung jalan tanpa OTP.

---

## Setup (Termux/Android)

Jalanin bot langsung dari HP Android pake Termux.

### 1. Install Termux

Download dari F-Droid: https://f-droid.org/packages/com.termux/

> ⚠️ Jangan pakai versi Play Store (outdated & bugs).

### 2. Clone & Setup

```bash
git clone <repo-url>
cd telegrambot-ai

# Jalankan setup (auto-install semua):
bash setup-termux.sh
```

Setup akan install: Python, tmux, dependencies, virtual environment.

### 3. Edit `.env`

```bash
nano .env
```

Isi credentials (sama kayak Windows):
- `API_ID` & `API_HASH` — dari https://my.telegram.org
- `PHONE` — nomor HP Telegram
- `UPSTASH_REDIS_URL` & `UPSTASH_REDIS_TOKEN`
- `AI_API_KEY` — sudah ada di `.env.example`

### 4. Jalankan

```bash
# Foreground (lihat logs langsung):
source .venv/bin/activate
python main.py

# Atau background (24/7 pake tmux):
./run-termux.sh
```

### 5. Management

```bash
# Cek logs (kalau background):
tmux attach -t tgaibot
# Detach: Ctrl+B lalu D

# Stop bot:
./stop-termux.sh

# Restart:
./stop-termux.sh && ./run-termux.sh
```

### 6. Auto-Start saat HP Boot (Optional)

```bash
# Install termux-boot:
pkg install termux-boot

# Copy script auto-start:
mkdir -p ~/.termux/boot
cp termux-boot.sh ~/.termux/boot/start-bot.sh
chmod +x ~/.termux/boot/start-bot.sh
```

Sekarang bot otomatis jalan setiap HP di-restart.

### Tips Termux

- **Wake lock**: `termux-wake-lock` biar Termux nggak di-kill Android
- **Battery optimization**: Matikan battery optimization untuk Termux di Settings → Battery
- **Background**: Pakai `./run-termux.sh` (tmux) biar bot tetap jalan kalau Termux di-minimize
- **Storage**: `termux-setup-storage` kalau butuh akses storage Android

---

## Command (prefix `.`, hanya owner)

| Command | Fungsi |
|---|---|
| `.help` | daftar command |
| `.ping` | cek hidup |
| `.me` | lihat ID akun (buat set OWNER_ID) |
| `.ai on/off` | on/off auto-reply |
| `.train` | statistik training data |
| `.mem [fakta]` | lihat/simpan memori |
| `.memclear` | hapus memori |
| `.bl [id]` / `.unbl id` | blacklist chat |
| `.aitest <teks>` | tes balasan AI |
| `.reload` | reload training data dari Upstash |

---

## Struktur

```
telegrambot-ai/
├── main.py              # entrypoint userbot + command + event handler
├── ai.py                # inti AI: training data dari Upstash, LLM, memori, tools
├── config.py            # load .env
├── tools.py             # waktu, kalkulator
├── logger.py            # logging berwarna
├── colab_scraper.py     # Google Colab notebook (scrape → upload Upstash)
├── colab_cells/         # Cell-by-cell version buat Colab
├── setup.bat            # Windows setup script
├── run.bat              # Windows run script
├── setup-termux.sh      # Termux/Android setup script
├── run-termux.sh        # Termux run (background via tmux)
├── stop-termux.sh       # Termux stop bot
├── termux-boot.sh       # Auto-start saat HP boot
├── Dockerfile           # Docker build (Railway)
├── railway.json         # Railway config
├── Procfile             # Process type declaration
├── .env.example         # template konfigurasi
└── data/                # ai-state.json + *.session (otomatis dibuat)
```

---

## Provider Auto-Fallback

Bot mencoba provider berurutan sampai dapat jawaban:

1. **Primary**: mimo-v2.5-free (default)
2. **Fallback 1**: laguna-s-2.1-free (reasoning)
3. **Fallback 2**: nemotron-3.5-lightning-free (reasoning)

Kalau semua kena rate-limit, bot dijeda otomatis selama `AI_COOLDOWN_SECONDS`.

---

## Training Data Flow

1. **Colab Scraper** — scrape N pesan terakhir dari semua chat
2. **Upload ke Upstash** — simpan sebagai chunked JSON di Redis
3. **Bot Startup** — load training data dari Upstash ke memori
4. **AI Context** — training data dipakai buat contoh gaya di system prompt
5. **`.reload`** — reload training data tanpa restart bot
