"""Date helpers on 'YYYY-MM-DD' strings, so no time zone can shift a day."""

import calendar
from datetime import date, timedelta

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def parse_day(s: str) -> date:
    return date.fromisoformat(s[:10])


def add_days(s: str, n: int) -> str:
    return (parse_day(s) + timedelta(days=n)).isoformat()


def diff_days(a: str, b: str) -> int:
    return (parse_day(a) - parse_day(b)).days


def add_months(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12}-{idx % 12 + 1:02d}"


def days_in_month(ym: str) -> int:
    return calendar.monthrange(int(ym[:4]), int(ym[5:7]))[1]


def add_months_day(s: str, n: int) -> str:
    ym = add_months(s[:7], n)
    d = min(int(s[8:10]), days_in_month(ym))
    return f"{ym}-{d:02d}"


def month_range(from_ym: str, to_ym: str) -> list[str]:
    out = []
    ym = from_ym
    while ym <= to_ym:
        out.append(ym)
        ym = add_months(ym, 1)
    return out


def month_index(ym: str) -> int:
    return int(ym[5:7]) - 1


def quarter_of(s: str) -> int:
    return (int(s[5:7]) - 1) // 3


def month_label(ym: str) -> str:
    return f"{MONTHS[month_index(ym)]} {ym[2:4]}"


def day_label(s: str) -> str:
    d = parse_day(s)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"
