// Bulk rename pair -> station in frontend/src (active pages only).
import fs from 'fs';
import path from 'path';

const skip = ['old_', 'gemini_', 'bug_', 'node_modules'];
const repls = [
  ['/api/pairs/', '/api/stations/'],
  ['pair_id', 'station_id'],
  ['pair_no', 'station_no'],
  ['ip_stock_no', 'current_operation'],
  ['op_stock_no', 'next_operation'],
  ['pair_name', 'station_name'],
  ['getPairLabel', 'getStationLabel'],
  ['fetchPairs', 'fetchStations'],
  ['setPairs', 'setStations'],
  ['pairForm', 'stationForm'],
  ['editPairId', 'editStationId'],
  ['showPairForm', 'showStationForm'],
  ['expandedPairId', 'expandedStationId'],
  ['openAddPair', 'openAddStation'],
  ['openEditPair', 'openEditStation'],
  ['savePair', 'saveStation'],
  ['deletePair', 'deleteStation'],
  ['pairMachines', 'stationMachines'],
  ['pairStats', 'stationStats'],
  ['pairId', 'stationId'],
  ['histoPairId', 'histoStationId'],
  ['setHistoPairId', 'setHistoStationId'],
  ['setPairId', 'setStationId'],
  ['applyToPair', 'applyToStation'],
  ['pairApplyResult', 'stationApplyResult'],
  ['setPairApplyResult', 'setStationApplyResult'],
  ['currentPair', 'currentStation'],
  ['pairNo', 'stationNo'],
  ['pair_created', 'station_created'],
  ['pair_updated', 'station_updated'],
  ['pair_deleted', 'station_deleted'],
  ["'pairs'", "'stations'"],
  ['"pairs"', '"stations"'],
  ['Pair Management', 'Station Management'],
  ['Pair No', 'Station No'],
  ['Pair *', 'Station *'],
  ['Add Pair', 'Add Station'],
  ['Edit Pair', 'Edit Station'],
  ['Select a pair', 'Select a station'],
  ['Select Pair', 'Select Station'],
  ['All Pairs', 'All Stations'],
  ['All Pair Groups', 'All Station Groups'],
  ['Paired Station Group', 'Station Group'],
  ['No pairs defined', 'No stations defined'],
  ['Delete this pair', 'Delete this station'],
  ['Pair updated', 'Station updated'],
  ['Pair added', 'Station added'],
  ['Pair deleted', 'Station deleted'],
  ['Failed to fetch pairs', 'Failed to fetch stations'],
  ['assigned to this pair', 'assigned to this station'],
  ["'Pair'", "'Station'"],
  ['IP Stock No', 'Current Operation'],
  ['OP Stock No', 'Next Operation'],
  ['IP Stock', 'Current Operation'],
  ['OP Stock', 'Next Operation'],
  ['Model (IP Stock)', 'Model / Variant'],
  ['titan/pair/', 'titan/station/'],
  ['Pair{n}', 'Station{n}'],
  ['per pair', 'per station'],
  ['paired line', 'station line'],
  ['const [pairs,', 'const [stations,'],
  ['pairs, setPairs]', 'stations, setStations]'],
  ['pairs.map(pair', 'stations.map(station'],
  ['pairs.length', 'stations.length'],
  ['pairs.find(p', 'stations.find(s'],
  ['(pair)', '(station)'],
  ['pair =>', 'station =>'],
  ['pair.', 'station.'],
  ["`Pair ${", "`Station ${"],
];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else if (fp.endsWith('.jsx') || fp.endsWith('.js')) {
      if (skip.some((s) => name.includes(s))) continue;
      if (name === 'rename_pair_to_station.js') continue;
      let text = fs.readFileSync(fp, 'utf8');
      const orig = text;
      for (const [a, b] of repls) text = text.split(a).join(b);
      if (text !== orig) {
        fs.writeFileSync(fp, text);
        console.log('updated', fp);
      }
    }
  }
}

walk('frontend/src');
