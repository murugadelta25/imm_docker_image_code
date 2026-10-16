"""Bulk rename pair -> station in frontend/src (active pages only)."""
import pathlib

skip = ("old_", "gemini_", "bug_", "node_modules")
repls = [
    ("/api/pairs/", "/api/stations/"),
    ("pair_id", "station_id"),
    ("pair_no", "station_no"),
    ("ip_stock_no", "current_operation"),
    ("op_stock_no", "next_operation"),
    ("pair_name", "station_name"),
    ("getPairLabel", "getStationLabel"),
    ("fetchPairs", "fetchStations"),
    ("setPairs", "setStations"),
    ("pairs", "stations"),
    ("pairForm", "stationForm"),
    ("editPairId", "editStationId"),
    ("showPairForm", "showStationForm"),
    ("expandedPairId", "expandedStationId"),
    ("openAddPair", "openAddStation"),
    ("openEditPair", "openEditStation"),
    ("savePair", "saveStation"),
    ("deletePair", "deleteStation"),
    ("pairMachines", "stationMachines"),
    ("pairStats", "stationStats"),
    ("pairId", "stationId"),
    ("histoPairId", "histoStationId"),
    ("setHistoPairId", "setHistoStationId"),
    ("setPairId", "setStationId"),
    ("applyToPair", "applyToStation"),
    ("pairApplyResult", "stationApplyResult"),
    ("setPairApplyResult", "setStationApplyResult"),
    ("currentPair", "currentStation"),
    ("pairNo", "stationNo"),
    ("pair_created", "station_created"),
    ("pair_updated", "station_updated"),
    ("pair_deleted", "station_deleted"),
    ("'pairs'", "'stations'"),
    ('"pairs"', '"stations"'),
    ("Pair Management", "Station Management"),
    ("Pair No", "Station No"),
    ("Pair *", "Station *"),
    ("Add Pair", "Add Station"),
    ("Edit Pair", "Edit Station"),
    ("Select a pair", "Select a station"),
    ("Select Pair", "Select Station"),
    ("All Pairs", "All Stations"),
    ("All Pair Groups", "All Station Groups"),
    ("Paired Station Group", "Station Group"),
    ("No pairs defined", "No stations defined"),
    ("Delete this pair", "Delete this station"),
    ("Pair updated", "Station updated"),
    ("Pair added", "Station added"),
    ("Pair deleted", "Station deleted"),
    ("Failed to fetch pairs", "Failed to fetch stations"),
    ("assigned to this pair", "assigned to this station"),
    ("'Pair'", "'Station'"),
    ("IP Stock No", "Current Operation"),
    ("OP Stock No", "Next Operation"),
    ("IP Stock", "Current Operation"),
    ("OP Stock", "Next Operation"),
    ("Model (IP Stock)", "Model / Variant"),
    ("titan/pair/", "titan/station/"),
    ("Pair{n}", "Station{n}"),
    ("per pair", "per station"),
    ("paired line", "station line"),
]

root = pathlib.Path("frontend/src")
for fp in root.rglob("*"):
    if fp.suffix not in (".jsx", ".js"):
        continue
    if any(s in fp.name for s in skip):
        continue
    text = fp.read_text(encoding="utf-8")
    orig = text
    for a, b in repls:
        text = text.replace(a, b)
    if text != orig:
        fp.write_text(text, encoding="utf-8")
        print("updated", fp)
