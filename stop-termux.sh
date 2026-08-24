#!/data/data/com.termux/files/usr/bin/bash
# ============================================
#   TELEGRAM BOT AI - STOP (Termux/Android)
# ============================================

SESSION_NAME="tgaibot"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    tmux kill-session -t "$SESSION_NAME"
    echo "[OK] Bot di-stop."
else
    echo "[OK] Bot tidak sedang jalan."
fi

# Release wake lock
termux-wake-unlock 2>/dev/null
