"""One-off bulk rename pair -> station in backend/app (run from repo root)."""
import pathlib

files = [f for f in pathlib.Path("backend/app").rglob("*.py") if f.name != "pairs.py"]
repls = [
    ("from ..models import Pair", "from ..models import Station"),
    (", Pair,", ", Station,"),
    (", Pair)", ", Station)"),
    ("db.query(Pair)", "db.query(Station)"),
    ("pair_id", "station_id"),
    ("pair_no", "station_no"),
    ("ip_stock_no", "current_operation"),
    ("op_stock_no", "next_operation"),
    ("pair_name", "station_name"),
    ("pair_map", "station_map"),
    ("_pair_label", "_station_label"),
    ("pair_stats", "station_stats"),
    ("pair-numbers", "station-numbers"),
    ("get_pair_numbers", "get_station_numbers"),
    ('"Pair"', '"Station"'),
    ('"Pair No"', '"Station No"'),
    ('"By Pair"', '"By Station"'),
    ('"IP Stock"', '"Current Operation"'),
    ('"OP Stock"', '"Next Operation"'),
    ('"IP Stock No"', '"Current Operation"'),
    ('"OP Stock No"', '"Next Operation"'),
    ("Pair with id", "Station with id"),
    ("Pair not found", "Station not found"),
    ("Pair name", "Station name"),
    ("/pipeline/{pair_no}", "/pipeline/{station_no}"),
    ("pair_created", "station_created"),
    ("pair_updated", "station_updated"),
    ("pair_deleted", "station_deleted"),
    ("Returns all pairs", "Returns all stations"),
    ("grouped by pair", "grouped by station"),
    ("patch pair_no", "patch station_no"),
]
for fp in files:
    text = fp.read_text(encoding="utf-8")
    orig = text
    for a, b in repls:
        text = text.replace(a, b)
    if text != orig:
        fp.write_text(text, encoding="utf-8")
        print("updated", fp)
