"""Pure logic for the Focus Up desktop app: no GUI, no I/O, so it can be unit tested.

Mirrors the maths in extension/shared.js and extension/dashboard.js.
"""
import calendar
import math
import datetime as dt

EARLY_PHRASE = 'I am choosing to end my focus early'


def active_seconds(state, now_ms):
    """Unpaused seconds, derived from timestamps (ms since epoch) exactly like the extension."""
    if not state:
        return 0
    paused_at = state.get('pausedAt')
    end = paused_at if paused_at is not None else now_ms
    paused = sum(p['end'] - p['start'] for p in state.get('pauses', []))
    return max(0, int((end - state['startedAt'] - paused) // 1000))


DEFAULT_BREAKS = {'enabled': True, 'work': 50, 'rest': 10, 'longRest': 20, 'longEvery': 4}


def break_plan(state, breaks, now_ms):
    """Where the session is in its work/rest cycle. Mirrors breakPlan() in extension/shared.js.

    in_rest=True  -> rest_left seconds of rest remain.
    in_rest=False -> the next rest (rest_min minutes, is_long?) starts in due_in seconds.
    """
    b = {**DEFAULT_BREAKS, **(breaks or {})}
    rest = state.get('rest')
    if rest:
        return {'enabled': b['enabled'], 'in_rest': True, 'due_in': None, 'is_long': bool(rest.get('long')),
                'rest_left': max(0, math.ceil((rest['until'] - now_ms) / 1000)), 'rest_min': rest.get('minutes', 0)}
    n = (state.get('breaksTaken') or 0) + 1
    is_long = b['longEvery'] > 0 and n % b['longEvery'] == 0
    since = active_seconds(state, now_ms) - (state.get('stretchStartSec') or 0)
    return {'enabled': b['enabled'], 'in_rest': False, 'rest_left': 0, 'is_long': is_long,
            'due_in': max(0, b['work'] * 60 - since), 'rest_min': b['longRest'] if is_long else b['rest']}


def fmt_ms(sec):
    sec = max(0, int(sec))
    return f'{sec // 60:02d}:{sec % 60:02d}'



def fmt_clock(sec):
    return f'{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}'


def fmt_duration(sec):
    h, m = sec // 3600, sec % 3600 // 60
    return f'{h}h {m:02d}m' if h else f'{m}m'


def session_date(session):
    """Local calendar day a session belongs to (the day it started)."""
    start = dt.datetime.fromisoformat(session['start'].replace('Z', '+00:00'))
    return start.astimezone().date()


def session_time(iso):
    return dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone().strftime('%H:%M')


def group_by_day(sessions):
    days = {}
    for s in sessions:
        try:
            days.setdefault(session_date(s), []).append(s)
        except (KeyError, ValueError):
            continue  # skip malformed rows rather than crash the calendar
    return days


def day_total(sessions):
    return sum(s.get('activeSeconds', 0) for s in sessions or [])


def heat_level(sec):
    if sec <= 0:
        return 0
    if sec < 1800:
        return 1
    if sec < 3600:
        return 2
    if sec < 7200:
        return 3
    return 4


def month_weeks(year, month):
    """Weeks (Monday first) as lists of day numbers, 0 for padding."""
    return calendar.Calendar(firstweekday=0).monthdayscalendar(year, month)


def compute_stats(sessions, today):
    days = group_by_day(sessions)
    week_start = today - dt.timedelta(days=today.weekday())
    week = sum(day_total(days.get(week_start + dt.timedelta(days=i))) for i in range(7))
    elapsed = today.weekday() + 1

    # Streak counts back from today, or from yesterday if today has no session yet.
    cursor = today if today in days else today - dt.timedelta(days=1)
    streak = 0
    while cursor in days:
        streak += 1
        cursor -= dt.timedelta(days=1)

    return {
        'week': week,
        'daily_avg': round(week / elapsed),
        'streak': streak,
        'longest': max((s.get('activeSeconds', 0) for s in sessions), default=0),
        'count': len(sessions),
    }


def blend(c1, c2, t):
    """Mix two #rrggbb colours; t=0 gives c1, t=1 gives c2."""
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(x + (y - x) * t):02x}' for x, y in zip(a, b))


# ---------- projects ----------
# A project is {"id", "name", "parentId"}. A session's time counts for its project and for every
# ancestor, so working on Y (inside X) also grows X. Mirrors extension/shared.js.

def clean_project_name(s):
    return ' '.join(str(s or '').split())[:80]


def _by_id(projects):
    return {p['id']: p for p in projects}


def children_map(projects):
    """Children per parent id. A parent that doesn't exist is treated as top level (None)."""
    by_id = _by_id(projects)
    out = {}
    for p in projects:
        key = p.get('parentId') if p.get('parentId') in by_id else None
        out.setdefault(key, []).append(p)
    for kids in out.values():
        kids.sort(key=lambda p: p['name'].lower())
    return out


def descendant_ids(projects, pid):
    """The project plus everything beneath it."""
    kids = children_map(projects)
    out, stack = {pid}, [pid]
    while stack:
        for c in kids.get(stack.pop(), []):
            if c['id'] not in out:
                out.add(c['id'])
                stack.append(c['id'])
    return out


def project_path(projects, pid):
    by_id, names, seen = _by_id(projects), [], set()
    p = by_id.get(pid)
    while p and p['id'] not in seen:
        seen.add(p['id'])
        names.insert(0, p['name'])
        p = by_id.get(p.get('parentId'))
    return ' › '.join(names)


def flatten_projects(projects):
    """Depth-first [(project, depth)], parents before children."""
    kids, out, seen = children_map(projects), [], set()

    def walk(parent, depth):
        for p in kids.get(parent, []):
            if p['id'] in seen:
                continue
            seen.add(p['id'])
            out.append((p, depth))
            walk(p['id'], depth + 1)
    walk(None, 0)
    out.extend((p, 0) for p in projects if p['id'] not in seen)  # only reachable through a cycle
    return out


def project_totals(projects, sessions, keep=None):
    """{id: {'own', 'total', 'count'}} in seconds. `keep(session)` filters (e.g. this week)."""
    by_id = _by_id(projects)
    totals = {p['id']: {'own': 0, 'total': 0, 'count': 0} for p in projects}
    for s in sessions:
        pid = s.get('projectId')
        if pid not in by_id or (keep and not keep(s)):
            continue
        secs = s.get('activeSeconds', 0)
        totals[pid]['own'] += secs
        totals[pid]['count'] += 1
        seen, p = set(), by_id[pid]
        while p and p['id'] not in seen:
            seen.add(p['id'])
            totals[p['id']]['total'] += secs
            p = by_id.get(p.get('parentId'))
    return totals


def filter_sessions(projects, sessions, flt):
    """flt: '' = everything, 'none' = no project, otherwise a project id (and its subprojects)."""
    if not flt:
        return list(sessions)
    ids = {p['id'] for p in projects}
    if flt == 'none':
        return [s for s in sessions if s.get('projectId') not in ids]
    keep = descendant_ids(projects, flt)
    return [s for s in sessions if s.get('projectId') in keep]
