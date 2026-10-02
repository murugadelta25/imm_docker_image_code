# -*- coding: utf-8 -*-
"""Generate IMM SIE -> EAP integrated Node-RED flow (IMM07-11 + Plastech)."""
import json
from pathlib import Path

Z = "25db418d496ffe93"
BROKER = "28778a3f76848bc9"

FLEET = {
    "IMM_07": {"machine_id": 1, "machine_name": "IMM_07"},
    "IMM_08": {"machine_id": 2, "machine_name": "IMM_08"},
    "IMM17": {"machine_id": 3, "machine_name": "IMM17"},
    "IMM18": {"machine_id": 4, "machine_name": "IMM18"},
    "IMM_09": {"machine_id": 5, "machine_name": "IMM_09"},
    "IMM_10": {"machine_id": 6, "machine_name": "IMM_10"},
    "IMM_11": {"machine_id": 7, "machine_name": "IMM_11"},
}

SAVE_EAP = r"""const cfg = msg.payload || {};

if (cfg.webhook_url) {
  const url = String(cfg.webhook_url).trim().replace(/\/+$/, '');
  global.set('EAP_WEBHOOK_URL', url);
}
if (cfg.webhook_secret !== undefined) {
  global.set('EAP_WEBHOOK_SECRET', String(cfg.webhook_secret || ''));
}
if (cfg.eap_host) global.set('EAP_HOST', String(cfg.eap_host).trim());
if (cfg.eap_port) global.set('EAP_PORT', String(cfg.eap_port).trim());
if (cfg.use_port80 === true) {
  const host = cfg.eap_host || global.get('EAP_HOST') || '192.168.1.110';
  global.set('EAP_WEBHOOK_URL', `http://${host}/api/imm/nodered/webhook/push`);
}

const interval = Number(cfg.push_min_interval_ms);
global.set('EAP_PUSH_MIN_INTERVAL_MS', Number.isFinite(interval) && interval >= 0 ? interval : 10000);
global.set('EAP_PUSH_ON_CHANGE_ONLY', cfg.push_on_change_only !== false);

const active = global.get('EAP_WEBHOOK_URL') || '(host/port fallback)';
const thr = global.get('EAP_PUSH_MIN_INTERVAL_MS') + 'ms change=' + global.get('EAP_PUSH_ON_CHANGE_ONLY');
node.status({ fill: 'blue', shape: 'ring', text: active + ' | ' + thr });
node.warn('EAP webhook URL set: ' + active + ' throttle=' + thr);
return null;"""

SAVE_FLEET = r"""const raw = msg.payload || {};
const map = {};
Object.keys(raw).forEach((k) => {
  const row = raw[k] || {};
  const mid = Number(row.machine_id);
  if (!Number.isFinite(mid) || mid <= 0) return;
  map[String(k).trim().toUpperCase()] = {
    machine_id: mid,
    machine_name: String(row.machine_name || k).trim()
  };
});
global.set('EAP_MACHINE_FLEET', map);
const summary = Object.keys(map).map((k) => k + '->' + map[k].machine_id).join(', ');
node.status({ fill: 'blue', shape: 'dot', text: summary || 'empty map' });
node.warn('EAP machine fleet map: ' + (summary || '(empty)'));
return null;"""

ROUTE_PLASTECH = r"""const raw = msg.payload;
if (!raw || !raw.trx) return null;

const trxName = String(raw.trx.name || '').trim();
msg.topic = trxName;
msg.payload = raw;

const routeIndex = {
  IMM17: 0,
  IMM18: 1,
  PowerFactor: 2,
  Total_enery_cumulative: 3,
  Total_energy_cumulative: 3,
  EM_Current: 4,
  EM_Voltage: 5
};

let outIdx = routeIndex[trxName];
if (outIdx === undefined) {
  const n = trxName.toLowerCase().replace(/enery/g, 'energy');
  if (n === 'powerfactor' || n.includes('power_factor')) outIdx = 2;
  else if (n.includes('total') && (n.includes('cumul') || n.includes('energy'))) outIdx = 3;
  else if (n === 'em_current' || n.includes('current')) outIdx = 4;
  else if (n === 'em_voltage' || n.includes('voltage')) outIdx = 5;
}
if (outIdx === undefined) {
  node.status({ fill: 'yellow', shape: 'ring', text: 'skip ' + trxName });
  return null;
}

const outputs = [null, null, null, null, null, null];
outputs[outIdx] = msg;
node.status({ fill: 'green', shape: 'dot', text: trxName });
return outputs;"""

MAP_MACHINE = r"""const DEVICE = 'a916642e-1be4-4f54-a9ae-da2a4d074e91';
const p = msg.payload || {};
const trx = p.trx || {};
const body = trx.body || {};
const machine = String(trx.name || msg.topic || '').trim().toUpperCase();

const boolish = (v) => {
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'on') return 'true';
  if (s === 'false' || s === '0' || s === 'off') return 'false';
  return String(v);
};

const parameters = {};
Object.keys(body).forEach((k) => {
  const v = body[k];
  if (v === null || v === undefined || v === '') return;
  parameters[k] = String(v);
  const lk = k.toLowerCase();
  if (lk.includes('heater')) parameters.Heater_Status = boolish(v);
  else if (lk.includes('motor')) parameters.Motor_Status = boolish(v);
  else if (lk.includes('injection')) parameters.Injection_Status = boolish(v);
  else if (lk.includes('refill')) parameters.Refilling_Status = boolish(v);
});

parameters.Connection_Status = 'true';

msg.payload = {
  id: p.id,
  device: p.device || DEVICE,
  device_name: machine,
  machine_name: machine,
  trx: { name: machine, body: parameters },
  body: parameters,
  origin: p.origin,
  ts: p.ts
};
msg.topic = machine;
return msg;"""

MAP_ENERGY = r"""const DEVICE = 'a916642e-1be4-4f54-a9ae-da2a4d074e91';
const ENERGY_MACHINES = ['IMM17', 'IMM18'];

const p = msg.payload || {};
const trx = p.trx || {};
const body = trx.body || {};
const trxName = String(trx.name || msg.topic || '').trim();
const trxNorm = trxName.toLowerCase().replace(/enery/g, 'energy');

const mapped = {};
const set = (k, v) => {
  if (v === null || v === undefined || v === '') return;
  mapped[k] = String(v);
};

const pick = (...keys) => {
  for (const k of keys) {
    if (body[k] !== null && body[k] !== undefined && body[k] !== '') return body[k];
  }
  const lower = {};
  Object.keys(body).forEach((k) => { lower[k.toLowerCase()] = body[k]; });
  for (const k of keys) {
    const v = lower[String(k).toLowerCase()];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
};

if (trxNorm === 'powerfactor' || trxNorm.includes('power_factor')) {
  set('Energy_Power_Factor', pick('AveragePF', 'AvgPF', 'Avg_PF'));
  set('Energy_PF1', pick('PowerFactor-PF1', 'PowerFactor_PF1', 'PF1'));
  set('Energy_PF2', pick('PowerFactor_PF2', 'PF2'));
  set('Energy_PF3', pick('PowerFactor_PF3', 'PF3'));
} else if (trxNorm.includes('total') && (trxNorm.includes('cumul') || trxNorm.includes('energy'))) {
  const active = pick('Total_Active_Energy', 'TotalActiveEnergy', 'Active_Energy', 'Energy_Shift_Kwh');
  const apparent = pick('Total_Appearent_Energy', 'Total_Apparent_Energy', 'TotalApparentEnergy', 'Energy_Shift_Kvah');
  const reactive = pick('Total_Reactive_Energy', 'TotalReactiveEnergy', 'Energy_Shift_Kvarh');
  set('Total_Active_Energy', active);
  set('Total_Appearent_Energy', apparent);
  set('Total_Reactive_Energy', reactive);
  set('Energy_Shift_Kwh', active);
  set('Energy_Shift_Kvah', apparent);
  set('Energy_Shift_Kvarh', reactive);
} else if (trxNorm === 'em_current' || (trxNorm.includes('current') && !trxNorm.includes('voltage'))) {
  set('Energy_Current_I1', pick('Current_I1', 'I1'));
  set('Energy_Current_I2', pick('Current_I2', 'I2'));
  set('Energy_Current_I3', pick('Current_I3', 'I3'));
  const nums = [pick('Current_I1', 'I1'), pick('Current_I2', 'I2'), pick('Current_I3', 'I3')]
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
  if (nums.length) {
    set('Energy_Ampere_Rating', (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3));
  }
} else if (trxNorm === 'em_voltage' || trxNorm.includes('voltage')) {
  set('Energy_Phase_to_Phase_Voltage', pick('Average_Voltage_LL', 'VLL', 'Avg_VLL'));
  set('Energy_Phase_to_Neutral_Voltage', pick('Voltage_V1toN', 'V1N'));
  set('Energy_Voltage_V1N', pick('Voltage_V1toN'));
  set('Energy_Voltage_V2N', pick('Voltage_V2toN'));
  set('Energy_Voltage_V3N', pick('Voltage_V3toN'));
  set('Energy_Voltage_V12', pick('Voltage_V1toV2'));
  set('Energy_Voltage_V23', pick('Voltage_V2toV3'));
  set('Energy_Voltage_V13', pick('Voltage_V1toV3'));
}

if (!Object.keys(mapped).length) {
  node.warn('Energy map empty for ' + trxName);
  return null;
}

const cache = global.get('immPlantEnergyCache') || {};
Object.assign(cache, mapped);
cache._updated_at = new Date().toISOString();
cache._last_trx = trxName;
global.set('immPlantEnergyCache', cache);

node.status({ fill: 'green', shape: 'dot', text: trxName + ' (' + Object.keys(mapped).length + 'p)' });

return ENERGY_MACHINES.map((machine) => ({
  topic: 'energy:' + machine,
  payload: {
    id: p.id,
    device: p.device || DEVICE,
    device_name: machine,
    machine_name: machine,
    trx: { name: 'EnergyMeter_' + trxName, body: mapped },
    body: mapped,
    origin: p.origin,
    ts: p.ts
  }
}));"""

NORMALIZE = r"""const DEVICE_LABELS = {
  'b695f76c-457a-4742-89d3-8950cc1f38a2': 'IMM_07',
  '279cb5fc-18b1-4b7a-8e0c-fde9fc1e8fdf': 'IMM_08',
  '69a56343-e331-4165-85a4-ebcc754d1f84': 'IMM_09',
  '3a678f1d-1a26-4c2f-a208-a59efbbfd522': 'IMM_10',
  'e3d7ca17-9f75-43fb-b8c4-c2b389245f63': 'IMM_11'
};

const DEFAULT_FLEET = {
  IMM_07: { machine_id: 1, machine_name: 'IMM_07' },
  IMM_08: { machine_id: 2, machine_name: 'IMM_08' },
  IMM17: { machine_id: 3, machine_name: 'IMM17' },
  IMM18: { machine_id: 4, machine_name: 'IMM18' },
  IMM_09: { machine_id: 5, machine_name: 'IMM_09' },
  IMM_10: { machine_id: 6, machine_name: 'IMM_10' },
  IMM_11: { machine_id: 7, machine_name: 'IMM_11' }
};

const p = msg.payload || {};
let body = {};
if (p.body && typeof p.body === 'object' && !Array.isArray(p.body)) {
  body = p.body;
} else if (p.trx && p.trx.body && typeof p.trx.body === 'object') {
  body = p.trx.body;
} else if (typeof p === 'object' && p.Actual_Cycle_Time !== undefined) {
  body = p;
}

const deviceId = String(p.device || msg.device || '').trim();
if (!deviceId) {
  node.warn('IMM trx missing device UUID');
  return null;
}

const trxName = String((p.trx && p.trx.name) || p.name || msg.topic || '').trim();
let label = String(p.machine_name || p.device_name || '').trim();
if (!label && /^IMM\d+$/i.test(trxName)) label = trxName.toUpperCase();
if (!label && DEVICE_LABELS[deviceId]) label = DEVICE_LABELS[deviceId];
if (!label) label = deviceId;

const fleet = global.get('EAP_MACHINE_FLEET') || DEFAULT_FLEET;
const mapped = fleet[String(label).toUpperCase()] || fleet[label] || null;

if (!mapped || !mapped.machine_id) {
  node.warn('No EAP fleet map for ' + label + ' - edit inject "2 Set machine fleet map"');
  node.status({ fill: 'red', shape: 'ring', text: 'unmapped ' + label });
  return null;
}

const parameters = {};
Object.keys(body).forEach((k) => {
  const v = body[k];
  if (v !== null && v !== undefined && v !== '') {
    parameters[k] = String(v);
  }
});

const entry = {
  machine_id: Number(mapped.machine_id),
  machine_name: String(mapped.machine_name || label),
  device_id: deviceId,
  device_name: label,
  trx_name: trxName,
  message_id: p.id || null,
  received_at: new Date().toISOString(),
  parameter_count: Object.keys(parameters).length,
  parameters
};

const storeKey = 'm' + entry.machine_id;
const store = global.get('immLiveByDevice') || {};
const prev = store[storeKey] || {};
const mergedParams = Object.assign({}, prev.parameters || {}, parameters);
entry.parameters = mergedParams;
entry.parameter_count = Object.keys(mergedParams).length;
store[storeKey] = entry;
global.set('immLiveByDevice', store);

node.status({
  fill: 'green',
  shape: 'dot',
  text: entry.machine_name + ' -> fleet #' + entry.machine_id + ' (' + entry.parameter_count + 'p)'
});

msg.payload = entry;
msg.device_id = deviceId;
msg.machine_id = entry.machine_id;
msg.store_key = storeKey;
return msg;"""

THROTTLE = r"""const entry = msg.payload || {};
const mid = String(entry.machine_id || msg.machine_id || '').trim();
const trx = String(entry.trx_name || '').trim();
const isEnergy = trx.indexOf('EnergyMeter_') === 0;
const gateKey = mid + '|' + (isEnergy ? 'energy' : 'machine');
if (!mid) return null;

const minMs = Number(global.get('EAP_PUSH_MIN_INTERVAL_MS'));
const interval = Number.isFinite(minMs) && minMs >= 0 ? minMs : 10000;
const changeOnly = global.get('EAP_PUSH_ON_CHANGE_ONLY') !== false;

const params = entry.parameters || {};
const energyOnly = {};
Object.keys(params).forEach((k) => {
  if (/^(Energy_|Total_)/.test(k)) energyOnly[k] = params[k];
});
const sig = JSON.stringify(isEnergy ? energyOnly : params);
const now = Date.now();

const lastSig = global.get('immPushSigByDevice') || {};
const lastAt = global.get('immPushAtByDevice') || {};
const prevSig = lastSig[gateKey];
const prevAt = Number(lastAt[gateKey] || 0);
const changed = prevSig !== sig;
const due = (now - prevAt) >= interval;

// Energy totals / PF / V / I: push immediately when energy fields change (bypass short throttle)
if (isEnergy && changed) {
  lastSig[gateKey] = sig;
  lastAt[gateKey] = now;
  global.set('immPushSigByDevice', lastSig);
  global.set('immPushAtByDevice', lastAt);
  node.status({
    fill: 'green',
    shape: 'dot',
    text: 'push energy #' + mid + ' change'
  });
  return msg;
}

if (!due) {
  node.status({
    fill: 'yellow',
    shape: 'ring',
    text: 'throttle ' + Math.ceil((interval - (now - prevAt)) / 1000) + 's #' + mid
  });
  return null;
}

if (changeOnly && !changed) {
  // Heartbeat: still push occasionally so EAP does not mark Motor/Heater as Offline
  const hbMs = Number(global.get('EAP_PUSH_HEARTBEAT_MS'));
  const heartbeat = Number.isFinite(hbMs) && hbMs > 0 ? hbMs : 60000;
  const since = now - prevAt;
  if (since < heartbeat) {
    lastAt[gateKey] = now;
    global.set('immPushAtByDevice', lastAt);
    node.status({ fill: 'yellow', shape: 'ring', text: 'skip unchanged #' + mid });
    return null;
  }
  // fall through — force a keep-alive push
}

lastSig[gateKey] = sig;
lastAt[gateKey] = now;
global.set('immPushSigByDevice', lastSig);
global.set('immPushAtByDevice', lastAt);

node.status({
  fill: 'green',
  shape: 'dot',
  text: 'push ' + (entry.machine_name || '') + ' #' + mid + (changed ? ' change' : '')
});
return msg;"""

PREPARE = r"""const WEBHOOK_URL = global.get('EAP_WEBHOOK_URL');
const WEBHOOK_SECRET = global.get('EAP_WEBHOOK_SECRET') || '';

let url = WEBHOOK_URL;
if (!url) {
  const host = global.get('EAP_HOST') || '192.168.1.110';
  const port = global.get('EAP_PORT') || '8040';
  url = `http://${host}:${port}/api/imm/nodered/webhook/push`;
}

msg.method = 'POST';
msg.url = url;
msg.headers = { 'Content-Type': 'application/json' };
if (WEBHOOK_SECRET) {
  msg.headers['X-Webhook-Secret'] = WEBHOOK_SECRET;
}
return msg;"""

PUSH_STATUS = r"""const code = msg.statusCode || 0;
const ok = code >= 200 && code < 300;
node.status({
  fill: ok ? 'green' : 'red',
  shape: 'dot',
  text: (ok ? 'EAP OK ' : 'EAP ERR ') + code
});
if (!ok) {
  node.warn('EAP push failed ' + code + ' url=' + (global.get('EAP_WEBHOOK_URL') || ''));
}
return null;"""

HEALTH = r"""const store = global.get('immLiveByDevice') || {};
msg.payload = {
  ok: true,
  service: 'imm-nodered-api',
  eap_webhook_url: global.get('EAP_WEBHOOK_URL') || null,
  eap_machine_fleet: global.get('EAP_MACHINE_FLEET') || null,
  push_min_interval_ms: global.get('EAP_PUSH_MIN_INTERVAL_MS'),
  plant_energy: global.get('immPlantEnergyCache') || null,
  device_count: Object.keys(store).length,
  devices: Object.values(store).map(d => ({
    machine_id: d.machine_id,
    machine_name: d.machine_name,
    device_id: d.device_id,
    device_name: d.device_name,
    received_at: d.received_at,
    parameter_count: d.parameter_count
  })),
  updated_at: new Date().toISOString()
};
msg.statusCode = 200;
return msg;"""

LIVE_LIST = r"""const store = global.get('immLiveByDevice') || {};
msg.payload = {
  ok: true,
  count: Object.keys(store).length,
  devices: Object.values(store),
  plant_energy: global.get('immPlantEnergyCache') || null,
  updated_at: new Date().toISOString()
};
msg.statusCode = 200;
return msg;"""

LIVE_ONE = r"""const id = msg.req.params.deviceId;
const store = global.get('immLiveByDevice') || {};
let entry = store[id] || store['m' + id];
if (!entry) {
  entry = Object.values(store).find((d) => d.device_id === id || String(d.machine_id) === String(id));
}
if (!entry) {
  msg.payload = { ok: false, error: 'not found', device_id: id };
  msg.statusCode = 404;
} else {
  msg.payload = { ok: true, device: entry };
  msg.statusCode = 200;
}
return msg;"""

UPDATE_STATUS = r"""const store = global.get('immLiveByDevice') || {};
const n = Object.keys(store).length;
const ids = Object.values(store).map((d) => (d.machine_name || '?') + '#' + (d.machine_id || '?')).join(', ');
node.status({ fill: 'green', shape: 'dot', text: n + ' live: ' + ids });
return null;"""


def main():
    flow = [
        {
            "id": Z,
            "type": "tab",
            "label": "IMM SIE -> EAP API",
            "disabled": False,
            "info": (
                "# IMM SIE EDA -> EAP IMM PMS (PUSH)\n\n"
                "Includes IMM_07..IMM_11 plus **PLC_Plastech** (IMM17 / IMM18 + plant energy meter).\n\n"
                "## Configure\n"
                "1. Inject **1 Set EAP webhook URL**\n"
                "2. Inject **2 Set machine fleet map** (IMM17→3, IMM18→4)\n"
                "3. Deploy\n\n"
                "## Throttle\n"
                "Default: max **1 push / 10 seconds / machine** (energy gated separately), skip unchanged payloads.\n\n"
                "Do NOT use :5184 for webhook (frontend only)."
            ),
        },
        {
            "id": BROKER,
            "type": "broker-config",
            "name": "SIE",
            "host": "rabbitmq.eda",
            "port": "5672",
            "vhost": "",
            "tls": False,
            "credsFromSettings": False,
        },
        {
            "id": "e516968ac1e20a33",
            "type": "inject",
            "z": Z,
            "name": "1 Set EAP webhook URL",
            "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
            "repeat": "",
            "crontab": "",
            "once": True,
            "onceDelay": "1",
            "topic": "eap_config",
            "payload": json.dumps(
                {
                    "webhook_url": "http://192.168.1.110/api/imm/nodered/webhook/push",
                    "webhook_secret": "",
                    "push_min_interval_ms": 10000,
                    "push_on_change_only": True,
                }
            ),
            "payloadType": "json",
            "x": 200,
            "y": 720,
            "wires": [["4b34f65e5ba679b9"]],
        },
        {
            "id": "cb784e92a2a93390",
            "type": "inject",
            "z": Z,
            "name": "Re-apply EAP URL (manual)",
            "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
            "repeat": "",
            "crontab": "",
            "once": False,
            "onceDelay": 0.1,
            "topic": "eap_config",
            "payload": json.dumps(
                {
                    "webhook_url": "http://192.168.1.110/api/imm/nodered/webhook/push",
                    "webhook_secret": "",
                    "push_min_interval_ms": 10000,
                    "push_on_change_only": True,
                }
            ),
            "payloadType": "json",
            "x": 210,
            "y": 760,
            "wires": [["4b34f65e5ba679b9"]],
        },
        {
            "id": "4b34f65e5ba679b9",
            "type": "function",
            "z": Z,
            "name": "Save EAP config -> global",
            "func": SAVE_EAP,
            "outputs": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 480,
            "y": 740,
            "wires": [],
        },
        {
            "id": "f9999f1bb766b826",
            "type": "inject",
            "z": Z,
            "name": "2 Set machine fleet map",
            "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
            "repeat": "",
            "crontab": "",
            "once": True,
            "onceDelay": "1",
            "topic": "eap_fleet_map",
            "payload": json.dumps(FLEET),
            "payloadType": "json",
            "x": 210,
            "y": 820,
            "wires": [["5c932cb8d38612a2"]],
        },
        {
            "id": "4b4deb1f540c57ac",
            "type": "inject",
            "z": Z,
            "name": "Re-apply fleet map (manual)",
            "props": [{"p": "payload"}, {"p": "topic", "vt": "str"}],
            "repeat": "",
            "crontab": "",
            "once": False,
            "onceDelay": 0.1,
            "topic": "eap_fleet_map",
            "payload": json.dumps(FLEET),
            "payloadType": "json",
            "x": 220,
            "y": 860,
            "wires": [["5c932cb8d38612a2"]],
        },
        {
            "id": "5c932cb8d38612a2",
            "type": "function",
            "z": Z,
            "name": "Save fleet map -> global",
            "func": SAVE_FLEET,
            "outputs": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 480,
            "y": 840,
            "wires": [],
        },
        {
            "id": "20e0649d1e8d802e",
            "type": "function",
            "z": Z,
            "name": "Normalize & store IMM trx",
            "func": NORMALIZE,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 700,
            "y": 280,
            "wires": [["e944749009c8fd45", "1d6da275a1c5df59", "a71e0465d4cd9a01"]],
        },
        {
            "id": "a71e0465d4cd9a01",
            "type": "function",
            "z": Z,
            "name": "Throttle EAP push",
            "func": THROTTLE,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 960,
            "y": 280,
            "wires": [["aa5e54ffdd864e2d"]],
        },
        {
            "id": "aa5e54ffdd864e2d",
            "type": "function",
            "z": Z,
            "name": "Prepare EAP push",
            "func": PREPARE,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 960,
            "y": 360,
            "wires": [["7282a5c99eac65e8"]],
        },
        {
            "id": "7282a5c99eac65e8",
            "type": "http request",
            "z": Z,
            "name": "POST -> EAP webhook",
            "method": "use",
            "ret": "obj",
            "paytoqs": "ignore",
            "url": "",
            "tls": "",
            "persist": False,
            "proxy": "",
            "insecureHTTPParser": False,
            "authType": "",
            "senderr": False,
            "headers": [],
            "x": 1180,
            "y": 280,
            "wires": [["6f52559e8f68b419", "3e4fb50d192978a0"]],
        },
        {
            "id": "3e4fb50d192978a0",
            "type": "function",
            "z": Z,
            "name": "Push status",
            "func": PUSH_STATUS,
            "outputs": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 1420,
            "y": 340,
            "wires": [],
        },
        {
            "id": "6f52559e8f68b419",
            "type": "debug",
            "z": Z,
            "name": "EAP push response (debug)",
            "active": False,
            "tosidebar": True,
            "console": False,
            "tostatus": False,
            "complete": "true",
            "targetType": "full",
            "statusVal": "",
            "statusType": "auto",
            "x": 1460,
            "y": 260,
            "wires": [],
        },
        {
            "id": "e944749009c8fd45",
            "type": "debug",
            "z": Z,
            "name": "stored (enable to debug)",
            "active": False,
            "tosidebar": True,
            "console": False,
            "tostatus": False,
            "complete": "payload",
            "targetType": "msg",
            "statusVal": "",
            "statusType": "auto",
            "x": 960,
            "y": 120,
            "wires": [],
        },
        {
            "id": "1d6da275a1c5df59",
            "type": "function",
            "z": Z,
            "name": "Update flow status",
            "func": UPDATE_STATUS,
            "outputs": 0,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 960,
            "y": 180,
            "wires": [],
        },
        {
            "id": "088bee69122cdc20",
            "type": "http in",
            "z": Z,
            "name": "GET /imm/api/health",
            "url": "/imm/api/health",
            "method": "get",
            "upload": False,
            "swaggerDoc": "",
            "x": 160,
            "y": 940,
            "wires": [["9af178f5de2feb3b"]],
        },
        {
            "id": "9af178f5de2feb3b",
            "type": "function",
            "z": Z,
            "name": "Health check",
            "func": HEALTH,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 380,
            "y": 940,
            "wires": [["2dbd5c4ae587653e"]],
        },
        {
            "id": "4d078acc77371853",
            "type": "http in",
            "z": Z,
            "name": "GET /imm/api/live",
            "url": "/imm/api/live",
            "method": "get",
            "upload": False,
            "swaggerDoc": "",
            "x": 150,
            "y": 1000,
            "wires": [["54619e90ea686345"]],
        },
        {
            "id": "54619e90ea686345",
            "type": "function",
            "z": Z,
            "name": "Build live list",
            "func": LIVE_LIST,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 380,
            "y": 1000,
            "wires": [["2dbd5c4ae587653e"]],
        },
        {
            "id": "8915c8b67af49472",
            "type": "http in",
            "z": Z,
            "name": "GET /imm/api/live/:id",
            "url": "/imm/api/live/:deviceId",
            "method": "get",
            "upload": False,
            "swaggerDoc": "",
            "x": 170,
            "y": 1060,
            "wires": [["fd60750da5e213c8"]],
        },
        {
            "id": "fd60750da5e213c8",
            "type": "function",
            "z": Z,
            "name": "Build one device",
            "func": LIVE_ONE,
            "outputs": 1,
            "noerr": 0,
            "initialize": "",
            "finalize": "",
            "libs": [],
            "x": 390,
            "y": 1060,
            "wires": [["2dbd5c4ae587653e"]],
        },
        {
            "id": "2dbd5c4ae587653e",
            "type": "http response",
            "z": Z,
            "name": "JSON response",
            "statusCode": "",
            "headers": {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
            },
            "x": 620,
            "y": 1000,
            "wires": [],
        },
    ]

    devices = [
        ("fcd0bb088b7cdd85", "IMM_07", "b695f76c-457a-4742-89d3-8950cc1f38a2", 80),
        ("cb40e099ad6e741c", "IMM_08", "279cb5fc-18b1-4b7a-8e0c-fde9fc1e8fdf", 140),
        ("a898f65b50567878", "IMM_09", "69a56343-e331-4165-85a4-ebcc754d1f84", 200),
        ("afd03c46df7403a0", "IMM_10", "3a678f1d-1a26-4c2f-a208-a59efbbfd522", 260),
        ("ade75b2188e10ba1", "IMM_11", "e3d7ca17-9f75-43fb-b8c4-c2b389245f63", 320),
    ]
    for nid, name, uuid, y in devices:
        flow.append(
            {
                "id": nid,
                "type": "sie-device-data",
                "z": Z,
                "name": name,
                "broker": BROKER,
                "prefetch": 0,
                "noAck": True,
                "exchangeName": "message-bus",
                "exchangeType": "topic",
                "exchangeRoutingKey": f"eda.data.#.{uuid}.#",
                "exchangeDurable": True,
                "queueName": "",
                "queueExclusive": True,
                "queueDurable": False,
                "queueAutoDelete": True,
                "headers": "{}",
                "device": uuid,
                "x": 120,
                "y": y,
                "wires": [["20e0649d1e8d802e"]],
            }
        )

    flow.extend(
        [
            {
                "id": "plastech_sie_in",
                "type": "sie-device-data",
                "z": Z,
                "name": "PLC_Plastech",
                "broker": BROKER,
                "prefetch": 0,
                "noAck": True,
                "exchangeName": "message-bus",
                "exchangeType": "topic",
                "exchangeRoutingKey": "eda.data.trx.#.a916642e-1be4-4f54-a9ae-da2a4d074e91.#",
                "exchangeDurable": True,
                "queueName": "",
                "queueExclusive": True,
                "queueDurable": False,
                "queueAutoDelete": True,
                "headers": "{}",
                "device": "a916642e-1be4-4f54-a9ae-da2a4d074e91",
                "x": 130,
                "y": 460,
                "wires": [["plastech_route"]],
            },
            {
                "id": "plastech_route",
                "type": "function",
                "z": Z,
                "name": "Route Plastech by trx.name",
                "func": ROUTE_PLASTECH,
                "outputs": 6,
                "timeout": "",
                "noerr": 0,
                "initialize": "",
                "finalize": "",
                "libs": [],
                "x": 360,
                "y": 460,
                "wires": [
                    ["plastech_map_machine"],
                    ["plastech_map_machine"],
                    ["plastech_map_energy"],
                    ["plastech_map_energy"],
                    ["plastech_map_energy"],
                    ["plastech_map_energy"],
                ],
            },
            {
                "id": "plastech_map_machine",
                "type": "function",
                "z": Z,
                "name": "Map IMM17/18 status tags",
                "func": MAP_MACHINE,
                "outputs": 1,
                "noerr": 0,
                "initialize": "",
                "finalize": "",
                "libs": [],
                "x": 620,
                "y": 420,
                "wires": [["20e0649d1e8d802e", "dbg_plastech_machine"]],
            },
            {
                "id": "plastech_map_energy",
                "type": "function",
                "z": Z,
                "name": "Map energy + fan-out IMM17/18",
                "func": MAP_ENERGY,
                "outputs": 1,
                "noerr": 0,
                "initialize": "",
                "finalize": "",
                "libs": [],
                "x": 640,
                "y": 520,
                "wires": [["20e0649d1e8d802e", "dbg_plastech_energy"]],
            },
            {
                "id": "dbg_plastech_machine",
                "type": "debug",
                "z": Z,
                "name": "Plastech machine (debug)",
                "active": False,
                "tosidebar": True,
                "console": False,
                "tostatus": False,
                "complete": "payload",
                "targetType": "msg",
                "statusVal": "",
                "statusType": "auto",
                "x": 880,
                "y": 460,
                "wires": [],
            },
            {
                "id": "dbg_plastech_energy",
                "type": "debug",
                "z": Z,
                "name": "Plastech energy (debug)",
                "active": False,
                "tosidebar": True,
                "console": False,
                "tostatus": False,
                "complete": "payload",
                "targetType": "msg",
                "statusVal": "",
                "statusType": "auto",
                "x": 880,
                "y": 560,
                "wires": [],
            },
        ]
    )

    out = Path(__file__).resolve().parent / "IMM_SIE_EAP_integrated_Plastech.json"
    out.write_text(json.dumps(flow, indent=2), encoding="utf-8")
    print(f"Wrote {out} ({len(flow)} nodes)")


if __name__ == "__main__":
    main()
