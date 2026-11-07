from datetime import date, timedelta


def resolve_range(start: date | None, end: date | None) -> tuple[date, date]:
    today = date.today()
    end_day = end or today
    start_day = start or (end_day - timedelta(days=29))
    if start_day > end_day:
        start_day, end_day = end_day, start_day
    return start_day, end_day


def previous_range(start: date, end: date) -> tuple[date, date]:
    span = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    return prev_end - timedelta(days=span - 1), prev_end


def iso(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def f(value) -> float | None:
    return None if value is None else float(value)


def delta(current: float | None, previous: float | None) -> float | None:
    if current is None or previous is None or previous == 0:
        return None
    return round((current - previous) / abs(previous), 4)
