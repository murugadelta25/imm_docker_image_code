"""Cycle stitching — merges raw machine status log segments into logical part cycles.

cycle_profile JSON shape (stored in parts.cycle_profile_json):
{
    "interruptions": 2,               # Ld/UnLd breaks inside one cycle (0 = disabled)
    "micro_run_threshold_sec": 10,    # Running segments <= this are pre-cycle setup moves
    "label": "3-position VMC"
}

Pattern matched (oldest-first) for interruptions=N, threshold=T:
    [Running(<=T)]  →  (Ld/UnLd → Running) × N

All matched segments are merged into one logical "running" row.
Raw DB rows are never modified — this is a pure display-time transform.
"""
from __future__ import annotations
from datetime import datetime
from typing import List, Optional


def _parse_ts(s) -> Optional[datetime]:
    if not s:
        return None
    clean = str(s).replace('Z', '').replace(' IST', '').replace(' ', 'T')
    try:
        return datetime.fromisoformat(clean)
    except ValueError:
        return None


def _dur_sec(row: dict, next_row: Optional[dict]) -> float:
    end_str = row.get('end_time') or (next_row['changed_at'] if next_row else None)
    if not end_str:
        return 0.0
    s = _parse_ts(row['changed_at'])
    e = _parse_ts(end_str)
    if not s or not e:
        return 0.0
    return max(0.0, (e - s).total_seconds())


def stitch_cycles(rows: List[dict], profile: Optional[dict]) -> List[dict]:
    """Return rows with multi-segment cycles merged per profile.

    rows    — newest-first list as returned by the status-log API
    profile — cycle_profile dict from part master, or None to pass through unchanged
    """
    if not profile or not rows:
        return rows

    interruptions = int(profile.get('interruptions') or 0)
    threshold_sec = int(profile.get('micro_run_threshold_sec') or 0)

    if interruptions <= 0:
        return rows

    # Work oldest-first, restore newest-first at the end
    ordered: List[dict] = list(reversed(rows))
    out: List[dict] = []
    i = 0
    total = len(ordered)

    while i < total:
        group = _match_group(ordered, i, total, interruptions, threshold_sec)
        if group is not None:
            absorbed, consumed = group
            out.append(_merge(absorbed, ordered, i + consumed))
            i += consumed
        else:
            out.append({**ordered[i], 'is_stitched': False, 'merged_count': 1})
            i += 1

    out.reverse()
    return out


def _match_group(ordered, start, total, interruptions, threshold_sec):
    """Try to match the full cycle pattern starting at `start`.

    Returns (absorbed_rows, consumed_count) or None.
    Pattern (oldest-first):
        [Running(<=threshold)]  then  (Ld/UnLd → Running) × interruptions
    """
    pos = start
    absorbed = []

    # Optional leading micro-run
    if pos < total and ordered[pos]['status'] == 'running' and threshold_sec > 0:
        d = _dur_sec(ordered[pos], ordered[pos + 1] if pos + 1 < total else None)
        if 0 < d <= threshold_sec:
            absorbed.append(ordered[pos])
            pos += 1

    # Require at least one (Ld/UnLd → Running) pair
    if pos + 1 >= total:
        return None

    for _ in range(interruptions):
        if pos + 1 >= total:
            return None
        if ordered[pos]['status'] != 'idle':
            return None
        if ordered[pos + 1]['status'] != 'running':
            return None
        absorbed.append(ordered[pos])      # Ld/UnLd (idle < threshold → ld/unld in UI)
        absorbed.append(ordered[pos + 1])  # Running
        pos += 2

    if len(absorbed) < 2:
        return None

    return absorbed, pos - start


def _merge(absorbed: List[dict], ordered: List[dict], next_idx: int) -> dict:
    first = absorbed[0]
    last = absorbed[-1]
    next_row = ordered[next_idx] if next_idx < len(ordered) else None

    end_time = last.get('end_time') or (next_row['changed_at'] if next_row else None)

    reasons = [r['deviation_reason'] for r in absorbed if r.get('deviation_reason')]

    return {
        'id': first['id'],
        'status': 'running',
        'changed_at': first['changed_at'],
        'end_time': end_time,
        'source': first.get('source', ''),
        'deviation_reason': ' | '.join(reasons) if reasons else '',
        'is_stitched': True,
        'merged_count': len(absorbed),
        'stitched_ids': [r['id'] for r in absorbed],
        'isOngoing': not end_time,
        '_consumed': len(absorbed),  # internal, stripped before API response
    }
