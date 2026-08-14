"""Logger sederhana buat userbot (pakai logging standar)."""
import logging
import os
import sys

_LEVEL = (os.getenv("LOG_LEVEL", "INFO") or "INFO").upper()


class _Fmt(logging.Formatter):
    _COLORS = {
        "DEBUG": "\033[90m",
        "INFO": "\033[36m",
        "WARNING": "\033[33m",
        "ERROR": "\033[31m",
        "CRITICAL": "\033[41m",
    }
    _RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color = self._COLORS.get(record.levelname, "")
        record.levelname = f"{color}{record.levelname}{self._RESET}"
        return super().format(record)


def get_logger(name: str) -> logging.Logger:
    log = logging.getLogger(name)
    if not log.handlers:
        h = logging.StreamHandler(sys.stdout)
        h.setFormatter(_Fmt("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
        log.addHandler(h)
        log.setLevel(_LEVEL)
        log.propagate = False
    return log


logger = get_logger("telegrambot-ai")
