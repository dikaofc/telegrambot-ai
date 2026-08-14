"""Agent tools (skill) — data real & akurat untuk AI: waktu, kalkulator, web, cuaca, kurs."""
import ast
import operator as _op
from datetime import datetime, timedelta, timezone

import httpx

WIB = timezone(timedelta(hours=7))

# ── waktu sekarang ───────────────────────────────────────────────────────────
def get_time() -> str:
    now = datetime.now(WIB)
    return now.strftime("%A, %d %B %Y, %H:%M WIB")


# ── kalkulator aman (tanpa eval) ─────────────────────────────────────────────
_BINOPS = {
    ast.Add: _op.add,
    ast.Sub: _op.sub,
    ast.Mult: _op.mul,
    ast.Div: _op.truediv,
    ast.Pow: _op.pow,
    ast.Mod: _op.mod,
    ast.FloorDiv: _op.floordiv,
}
_UNARY = {ast.USub: _op.neg, ast.UAdd: _op.pos}


def _eval_node(node: ast.AST):
    if isinstance(node, ast.Expression):
        return _eval_node(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        return _BINOPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_eval_node(node.operand))
    raise ValueError("ekspresi tidak didukung")


def calculate(expr: str) -> str | None:
    """Kalkulator aman. Return hasil (string) atau None kalau gagal."""
    try:
        val = _eval_node(ast.parse(expr.strip(), mode="eval"))
        if isinstance(val, float) and val.is_integer():
            val = int(val)
        return str(val)
    except Exception:
        return None


# ── pencarian web (DuckDuckGo instant answer, gratis tanpa key) ──────────────
async def search_web(query: str) -> str:
    """Pencarian fakta singkat via DuckDuckGo."""
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as c:
            r = await c.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1, "skip_disambig": 1},
                headers={"User-Agent": "telegrambot-ai/1.0"},
            )
            r.raise_for_status()
            d = r.json()
        abstract = (d.get("AbstractText") or "").strip()
        answer = (d.get("Answer") or "").strip()
        definition = (d.get("Definition") or "").strip()
        heading = (d.get("Heading") or "").strip()
        if answer:
            return f"{heading + ': ' if heading else ''}{answer}"
        if abstract:
            return abstract[:1500]
        if definition:
            return definition[:1500]
        related = [t.get("Text") for t in (d.get("RelatedTopics") or []) if t.get("Text")]
        if related:
            return "; ".join(related[:5])[:1500]
        return "tidak ada hasil relevan"
    except Exception as e:
        return f"pencarian gagal: {e}"


# ── cuaca (open-meteo, gratis tanpa key) ─────────────────────────────────────
async def get_weather(city: str) -> str:
    """Cuaca terkini sebuah kota via open-meteo."""
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as c:
            geo = await c.get(
                "https://geocoding-api.open-meteo.com/v1/search",
                params={"name": city, "count": 1, "language": "id"},
            )
            geo.raise_for_status()
            gd = geo.json()
        results = gd.get("results") or []
        if not results:
            return f"kota '{city}' tidak ditemukan"
        loc = results[0]
        name = loc.get("name", city)
        country = loc.get("country", "")
        lat, lon = loc["latitude"], loc["longitude"]
        async with httpx.AsyncClient(timeout=12) as c:
            w = await c.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
                    "timezone": "auto",
                },
            )
            w.raise_for_status()
            wd = w.json()
        cur = wd.get("current", {})
        code = int(cur.get("weather_code", 0))
        label = {
            0: "cerah", 1: "cerah", 2: "berawan sebagian", 3: "berawan",
            45: "berkabut", 48: "berkabut", 51: "gerimis", 61: "hujan ringan",
            63: "hujan", 65: "hujan deras", 80: "hujan lokal", 95: "badai petir",
        }.get(code, f"kode {code}")
        return (
            f"{name}, {country}: {cur.get('temperature_2m')}°C, {label}, "
            f"kelembapan {cur.get('relative_humidity_2m')}%, angin {cur.get('wind_speed_10m')} km/j"
        )
    except Exception as e:
        return f"cuaca gagal diambil: {e}"


# ── kurs mata uang (frankfurter.app, gratis tanpa key) ───────────────────────
async def convert_currency(amount: float, from_cur: str, to_cur: str) -> str:
    """Konversi mata uang dengan kurs terkini."""
    try:
        async with httpx.AsyncClient(timeout=12) as c:
            r = await c.get(
                "https://api.frankfurter.app/latest",
                params={"amount": amount, "from": from_cur.upper(), "to": to_cur.upper()},
            )
            r.raise_for_status()
            d = r.json()
        rates = d.get("rates", {})
        if to_cur.upper() not in rates:
            return f"tidak bisa konversi ke {to_cur.upper()}"
        return f"{amount} {from_cur.upper()} = {rates[to_cur.upper()]} {to_cur.upper()} (kurs {d.get('date')})"
    except Exception as e:
        return f"konversi gagal: {e}"
