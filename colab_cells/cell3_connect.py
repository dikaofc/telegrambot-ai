from telethon import TelegramClient
import asyncio

client = TelegramClient("colab_session", TELEGRAM_API_ID, TELEGRAM_API_HASH)
await client.start(phone=TELEGRAM_PHONE)

me = await client.get_me()
print(f"✅ Login sebagai: {me.first_name} (@{me.username}) ID: {me.id}")