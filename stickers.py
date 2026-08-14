"""Pustaka sticker userbot: muat semua sticker milik akun & pilih sesuai emoji/emotion."""

import random

from logger import logger

_LIBRARY: list[tuple[str, object]] = []  # (emoji, document)

# emoji kandidat per mode/emotion (dipakai buat milih sticker yang nyambung)
MODE_EMOJIS = {
    "mesra": ["❤️", "😘", "😍", "💕", "💋", "🥰", "💗", "😻"],
    "jorok": ["😏", "🔥", "🥵", "😈", "💦", "🤤", "😳"],
    "kasar": ["😤", "😡", "🤬", "💢", "😠"],
    "sopan": ["🙏", "👋", "😊", "👍"],
    "normal": ["😀", "😂", "🤣", "👍", "👌", "😅"],
}


def _doc_emoji(document) -> str:
    from telethon.tl.types import DocumentAttributeSticker

    for attr in getattr(document, "attributes", []) or []:
        if isinstance(attr, DocumentAttributeSticker):
            return getattr(attr, "alt", "") or ""
    return ""


async def load_stickers(client) -> int:
    """Ambil sticker userbot: set terpasang + favorit + baru dipakai. Return jumlah total (dedup)."""
    global _LIBRARY
    _LIBRARY = []
    seen: set[int] = set()

    def add(doc) -> None:
        if doc is None or getattr(doc, "id", None) in seen:
            return
        seen.add(doc.id)
        _LIBRARY.append((_doc_emoji(doc), doc))

    try:
        from telethon.tl.functions.messages import (
            GetAllStickersRequest,
            GetFavedStickersRequest,
            GetRecentStickersRequest,
        )

        # 1) sticker set yang terpasang (pack yang di-add ke panel sticker)
        n_sets = 0
        try:
            result = await client(GetAllStickersRequest(hash=0))
            for st in getattr(result, "sets", []) or []:
                n_sets += 1
                for doc in getattr(st, "documents", []) or []:
                    add(doc)
        except Exception as e:
            logger.warning("gagal ambil set sticker: %s", e)

        # 2) sticker favorit
        n_fav = 0
        try:
            fav = await client(GetFavedStickersRequest(hash=0))
            for doc in getattr(fav, "stickers", []) or []:
                add(doc)
                n_fav += 1
        except Exception as e:
            logger.warning("gagal ambil sticker favorit: %s", e)

        # 3) sticker yang baru dipakai (recent)
        n_rec = 0
        try:
            rec = await client(GetRecentStickersRequest(hash=0))
            for doc in getattr(rec, "stickers", []) or []:
                add(doc)
                n_rec += 1
        except Exception as e:
            logger.warning("gagal ambil sticker recent: %s", e)

        logger.info(
            "sticker: %d set terpasang, %d favorit, %d recent → %d total (dedup)",
            n_sets,
            n_fav,
            n_rec,
            len(_LIBRARY),
        )
    except Exception as e:
        logger.warning("gagal muat sticker: %s", e)
    logger.info("sticker dimuat: %d", len(_LIBRARY))
    return len(_LIBRARY)


def count() -> int:
    return len(_LIBRARY)


def has_stickers() -> bool:
    return bool(_LIBRARY)


def pick_sticker(emojis: list[str] | None = None):
    """Pilih sticker acak yang cocok dengan daftar emoji (fallback acak)."""
    if not _LIBRARY:
        return None
    if emojis:
        pool = [
            d
            for e, d in _LIBRARY
            if e and any(x and (x in e or e in x) for x in emojis)
        ]
        if pool:
            return random.choice(pool)
    return random.choice(_LIBRARY)[1]
