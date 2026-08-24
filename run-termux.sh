#!/data/data/com.termux/files/usr/bin/bash
# ============================================
#   TELEGRAM BOT AI - RUN (Termux/Android)
#   Jalanin bot di background pake tmux
# ============================================
set -e

SESSION_NAME="tgaibot"

# Cek .env
if [ ! -f ".env" ]; then
    echo "[!] .env belum ada. Jalankan setup-termux.sh dulu!"
    exit 1
fi

# Aktifkan wake lock (biar Android nggak kill Termux)
termux-wake-lock 2>/dev/null && echo "[OK] Wake lock aktif" || echo "[SKIP] Wake lock tidak tersedia"

# Cek apakah sudah jalan
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "[!] Bot sudah jalan di tmux session '$SESSION_NAME'"
    echo "    Cek: tmux attach -t $SESSION_NAME"
    echo "    Stop: ./stop-termux.sh"
    exit 0
fi

echo "[..] Starting bot in tmux session '$SESSION_NAME'..."
tmux new-session -d -s "$SESSION_NAME" "
    source .venv/bin/activate
    python main.py 2>&1 | tee data/bot.log
    echo '[!] Bot berhenti. Tekan Enter untuk close...'
    read
"

sleep 1

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "[OK] Bot sudah jalan!"
    echo
    echo "  Cek logs:    tmux attach -t $SESSION_NAME"
    echo "  Detach:      Ctrl+B lalu D"
    echo "  Stop:        ./stop-termux.sh"
    echo "  Restart:     ./stop-termux.sh && ./run-termux.sh"
else
    echo "[!] Gagal start bot. Cek logs: cat data/bot.log"
    exit 1
fi
