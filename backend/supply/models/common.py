"""Shared helpers for model output."""

from ..prng import js_round


def rnd(x: float, digits: int = 0) -> float:
    """Round half up to `digits` places for display. Model arithmetic is never rounded."""
    f = 10**digits
    v = js_round(x * f) / f
    return int(v) if digits == 0 else v
