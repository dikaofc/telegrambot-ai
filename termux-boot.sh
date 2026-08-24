#!/data/data/com.termux/files/usr/bin/bash
# ============================================
#   AUTO-START BOT SAAT TERMUX BOOT
#   Copy ke: ~/.termux/boot/start-bot.sh
#   Install: pkg install termux-boot
# ============================================

cd "$(dirname "$0")/.."

# Wake lock
termux-wake-lock

# Start bot
if [ -f "run-termux.sh" ]; then
    ./run-termux.sh
fi
