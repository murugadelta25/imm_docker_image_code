import pathlib

files = [
    "frontend/src/pages/ProductionPlanning.jsx",
    "frontend/src/pages/Dashboard.jsx",
    "frontend/src/pages/DataEntry.jsx",
    "frontend/src/pages/Breakdown.jsx",
    "frontend/src/pages/MaintenanceDashboard.jsx",
    "frontend/src/pages/MachineConfig.jsx",
    "frontend/src/pages/ModelChange.jsx",
    "frontend/src/pages/LossTracker.jsx",
]
repls = [
    ("stations.find(s => p.id ===", "stations.find(s => s.id ==="),
    ("const pair = stations.find", "const station = stations.find"),
    ("return pair ? (station.", "return station ? (station."),
    ("pair ? (station.", "station ? (station."),
    ("pairLabel", "stationLabel"),
    ("setPairForm", "setStationForm"),
    ("setEditPairId", "setEditStationId"),
    ("setShowPairForm", "setShowStationForm"),
    ("setExpandedPairId", "setExpandedStationId"),
    ("pairs.map(p =>", "stations.map(s =>"),
    ("{pairs.map", "{stations.map"),
    ("pairs.length", "stations.length"),
    ("No pairs available", "No stations available"),
    ("Add New Pair", "Add New Station"),
    ('label="Pair"', 'label="Station"'),
    ("validPairIds", "validStationIds"),
    ("planPairNos", "planStationNos"),
    ("pair:", "stationKey:"),
    ("ps.pair", "ps.stationKey"),
    ("'By Pair'", "'By Station'"),
    ("pair mode", "station mode"),
    ("pairHeader", "stationHeader"),
    ("pairRows", "stationRows"),
    ("pairWs", "stationWs"),
    ("Production By Pair", "Production By Station"),
    ("key={p.id} value={p.id}>{p.display_name || p.name}", "key={s.id} value={s.id}>{s.display_name || s.name}"),
    ("key={p.id} value={p.id}>{p.display_name}", "key={s.id} value={s.id}>{s.display_name}"),
    ("key={p.id} value={p.id}>{p.name}", "key={s.id} value={s.id}>{s.name}"),
]
for f in files:
    p = pathlib.Path(f)
    t = p.read_text(encoding="utf-8")
    orig = t
    for a, b in repls:
        t = t.replace(a, b)
    if t != orig:
        p.write_text(t, encoding="utf-8")
        print("fixed", f)
