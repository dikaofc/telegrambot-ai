#!/data/data/com.termux/files/usr/bin/bash
# ============================================
#   TELEGRAM BOT AI - SETUP (Termux/Android)
# ============================================
set -e

echo "============================================"
echo "  TELEGRAM BOT AI - SETUP (Termux)"
echo "============================================"
echo

# Update packages
echo "[..] Updating packages..."
pkg update -y && pkg upgrade -y

# Install dependencies
echo "[..] Installing dependencies..."
pkg install -y python git

# Update pip
echo "[..] Updating pip..."
pip install --upgrade pip

# Buat virtual environment
if [ ! -d ".venv" ]; then
    echo "[..] Membuat virtual environment..."
    python -m venv .venv
    echo "[OK] Virtual environment dibuat."
else
    echo "[OK] Virtual environment sudah ada."
fi
echo

# Aktifkan venv + install dependencies
echo "[..] Installing Python packages..."
source .venv/bin/activate
pip install -r requirements.txt
echo "[OK] Dependencies terinstall."
echo

# Cek .env
if [ ! -f ".env" ]; then
    echo "[..] Membuat .env dari template..."
    cp .env.example .env
    echo "[!!] .env sudah dibuat — TOLONG EDIT dulu sebelum jalanin!"
    echo "     nano .env"
    echo
    echo "     Isi: API_ID, API_HASH, PHONE, UPSTASH_REDIS_URL, dll."
    echo
else
    echo "[OK] .env sudah ada."
fi
echo

# Install tmux buat background running
echo "[..] Installing tmux (buat run 24/7)..."
pkg install -y tmux
echo "[OK] tmux terinstall."
echo

# Install termux-api buat wake lock
echo "[..] Installing termux-api (optional, buat wake lock)..."
pkg install -y termux-api 2>/dev/null || echo "[SKIP] termux-api gagal (optional)"
echo

echo "============================================"
echo "  SETUP SELESAI!"
echo "============================================"
echo
echo "  Untuk jalankan bot:"
echo "    source .venv/bin/activate"
echo "    python main.py"
echo
echo "  Untuk jalanin 24/7 (background):"
echo "    ./run-termux.sh"
echo
echo "  Untuk stop:"
echo "    ./stop-termux.sh"
echo
