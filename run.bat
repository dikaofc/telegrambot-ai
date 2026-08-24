@echo off
chcp 65001 >nul 2>&1
title Telegram Bot AI - Running

if not exist ".venv" (
    echo [!] Virtual environment belum ada. Jalankan setup.bat dulu!
    pause
    exit /b 1
)

call .venv\Scripts\activate.bat
python main.py
pause
