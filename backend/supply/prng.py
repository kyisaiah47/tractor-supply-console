"""Seeded random numbers, so the generated dataset is the same on every machine.

mulberry32 in 32-bit integer arithmetic. It gives the same sequence the original TypeScript
generator gave, so a planning date produces the same dataset as before the port.
"""

import math
from collections.abc import Sequence

M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & M32


class Rng:
    def __init__(self, seed: int) -> None:
        self.a = seed & M32

    def __call__(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & M32
        t = self.a
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296


def js_round(x: float) -> int:
    """Round half up, as JavaScript's Math.round does. Python's round() rounds half to even."""
    return math.floor(x + 0.5)


def rand_int(rng: Rng, lo: int, hi: int) -> int:
    return lo + math.floor(rng() * (hi - lo + 1))


def pick[T](rng: Rng, arr: Sequence[T]) -> T:
    return arr[math.floor(rng() * len(arr))]


def normal(rng: Rng, mean: float = 0.0, sd: float = 1.0) -> float:
    u = max(rng(), 1e-12)
    v = rng()
    return mean + sd * math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def poisson(rng: Rng, lam: float) -> int:
    if lam <= 0:
        return 0
    if lam > 30:
        return max(0, js_round(normal(rng, lam, math.sqrt(lam))))
    limit = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        k += 1
        p *= rng()
        if p <= limit:
            break
    return k - 1


def binomial(rng: Rng, n: int, p: float) -> int:
    if n <= 0 or p <= 0:
        return 0
    if n > 60:
        return min(n, max(0, js_round(normal(rng, n * p, math.sqrt(n * p * (1 - p))))))
    return sum(1 for _ in range(n) if rng() < p)
