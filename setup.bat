@echo off
chcp 65001 >nul 2>&1
title Telegram Bot AI - Setup

echo ============================================
echo   TELEGRAM BOT AI - SETUP
echo ============================================
echo.

:: Cek Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python belum terinstall.
    echo     Download dari: https://www.python.org/downloads/
    echo     PASTIKAN centang "Add Python to PATH" saat install.
    echo.
    echo     Atau install via winget:
    winget install Python.Python.3.12
    echo.
    pause
    exit /b 1
)

echo [OK] Python terdeteksi:
python --version
echo.

:: Buat virtual env
if not exist ".venv" (
    echo [..] Membuat virtual environment...
    python -m venv .venv
    echo [OK] Virtual environment dibuat.
) else (
    echo [OK] Virtual environment sudah ada.
)
echo.

:: Aktifkan venv + install dependencies
echo [..] Installing dependencies...
call .venv\Scripts\activate.bat
pip install -r requirements.txt --quiet
echo [OK] Dependencies terinstall.
echo.

:: Cek .env
if not exist ".env" (
    echo [..] Membuat .env dari template...
    copy .env.example .env >nul
    echo [!!] .env sudah dibuat — TOLONG EDIT dulu sebelum jalanin!
    echo     Buka .env di notepad, isi API_ID, API_HASH, PHONE, dll.
    echo.
    notepad .env
    pause
    exit /b 1
) else (
    echo [OK] .env sudah ada.
)
echo.

echo ============================================
echo   SETUP SELESAI!
echo ============================================
echo.
echo   Untuk jalankan bot:
echo     activate .venv
echo     python main.py
echo.
echo   Atau langsung klik: run.bat
echo.
pause
