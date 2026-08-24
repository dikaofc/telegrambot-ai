"""Agent tools — waktu & kalkulator saja (gratis, tanpa API key)."""
import ast
import operator as _op
from datetime import datetime, timedelta, timezone

WIB = timezone(timedelta(hours=7))


# ── waktu sekarang ─────────────────────────────────────────────────────────
def get_time() -> str:
    now = datetime.now(WIB)
    return now.strftime("%A, %d %B %Y, %H:%M WIB")


# ── kalkulator aman (tanpa eval) ──────────────────────────────────────────
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
