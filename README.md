# telegrambot-ai

Userbot Telegram (Telethon) yang membalas chat otomatis pakai AI, **belajar gaya bahasa kamu**, punya **memori**, **agent tools** (waktu, kalkulator, cari web, cuaca, kurs), dan bisa **transkripsi voice note → balas pakai suara**.

> Ini versi Telegram dari bot WhatsApp di repo ini. Ia meniru cara kamu ngetik — makin sering dipakai makin natural.

## Fitur

- **Auto-reply AI** multi-provider (OpenAI-compatible) + fallback berurutan + Ollama lokal.
- **Belajar gaya**: menyimpan korpus pesan kamu & lawan bicara, lalu meniru gaya (gaul/dry text/multibahasa).
- **Memori jangka panjang**: AI bisa menyimpan & mengingat fakta (nama, kesukaan, janji) via tool-calling.
- **Agent tools**: waktu WIB, kalkulator aman, pencarian web (DuckDuckGo), cuaca (open-meteo), kurs (frankfurter) — semua gratis tanpa key.
- **Voice note → STT → balasan suara**: Groq Whisper (transkripsi) + Microsoft Edge TTS (suara).
- **Command owner** untuk kendali penuh (`.ai`, `.mem`, `.bl`, dst).
- Sanitasi reasoning/chain-of-thought biar cuma jawaban final yang muncul.

## Setup

```bash
cd telegrambot-ai
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

Isi `.env`:

1. **Telegram userbot** — buka <https://my.telegram.org> → API development tools → salin `API_ID` & `API_HASH`.
2. **AI provider** (minimal salah satu):
   - `AI_BASE_URL` + `AI_MODEL` (+ `AI_API_KEY`), mis. Groq: `https://api.groq.com/openai/v1` & `llama-3.3-70b-versatile`.
   - atau `AI_FALLBACKS` untuk beberapa provider sekaligus.
   - atau Ollama lokal (`ollama serve` di localhost:11434) — fallback otomatis tanpa key.
3. **STT (opsional)** — `STT_API_KEY` dari Groq untuk balasan voice note.
4. `OWNER_ID` — ID numerik akun kamu (lihat dari `.me` setelah login pertama).

Jalankan:

```bash
python main.py
```

Login pertama akan diminta nomor HP + kode OTP (sesi tersimpan di `data/userbot.session`).

## Command (prefix `.`, hanya owner)

| Command | Fungsi |
|---|---|
| `.help` | daftar command |
| `.ping` | cek hidup |
| `.me` | lihat ID akun (buat set OWNER_ID) |
| `.ai on/off` | on/off auto-reply |
| `.aitrain` | statistik korpus gaya |
| `.aistyle` | contoh gaya yang dipelajari |
| `.aiclear` | hapus korpus gaya |
| `.mem [fakta]` | lihat/simpan memori |
| `.memclear` | hapus memori |
| `.bl [id]` / `.unbl id` | blacklist chat |
| `.aitest <teks>` | tes balasan AI |

## Cara kerja

- **Private chat** → semua pesan masuk dibalas otomatis.
- **Grup** → hanya saat di-mention (`@username`) atau di-reply (atur `AI_REPLY_IN_GROUPS=true`).
- Pesan kamu (outgoing) ikut dipelajari jadi korpus gaya.
- Voice note → transkripsi → AI balas isinya → dibacakan jadi voice note (mode `AI_REPLY_VOICE=voice|always|off`).

## Struktur

```
telegrambot-ai/
├── main.py        # entrypoint userbot + command + event handler
├── ai.py          # inti auto-reply: LLM, gaya, memori, tool-calling, sanitize
├── config.py      # load .env
├── tools.py       # waktu, kalkulator, web, cuaca, kurs
├── stt.py         # Groq Whisper
├── tts.py         # edge-tts
├── logger.py      # logging berwarna
└── data/          # ai-state.json + *.session (otomatis dibuat)
```
