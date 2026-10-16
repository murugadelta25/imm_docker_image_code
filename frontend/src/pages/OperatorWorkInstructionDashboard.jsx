import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { assetUrl } from '../api/config';
import PageHeader from '../components/PageHeader';
import QcInspectionSheet from '../components/QcInspectionSheet';
import LiveStatusButton from '../components/LiveStatusButton';
import TitanModal from '../components/basic/TitanModal';
import ProcessControlSheet, { printProcessControlSheet } from '../components/ProcessControlSheet';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass, withSurfaceClass } from '../themes/tileHelpers';
import {
  getWorkInstructionStyles,
  MACHINE_STATUS_COLORS,
} from '../themes/workInstructionStyles';
import { useConfig, getCurrentShift } from '../context/ConfigContext';
import { useWebSocket } from '../api/useWebSocket';
import { useAuth } from '../context/AuthContext';
import { INSTANCE_STATUS_LABEL, instanceStatusTheme } from '../utils/qcShiftHours';
import { formatCtSeconds } from '../utils/cycleTime';
import { DRAFT_KEYS, loadDraft, saveDraft } from '../utils/formPersistence';
import SpcWarningBanner from '../components/SpcWarningBanner';
import { isImageDocUrl } from '../utils/uploadLimits';
import { docTypeLabel } from '../utils/docTypes';

function PdfThumb({ url, label, revision, revDate, onOpen, s, t }) {
  if (!url) {
    return (
      <div style={s.docTileEmpty}>No {label} uploaded</div>
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className={withSurfaceClass(t, 'nested')}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      style={s.docTile}
    >
      <div style={s.docIcon}>📄</div>
      <div style={s.docLabel}>{label}</div>
      <div style={s.docMeta}>Rev {revision || '0'}</div>
      {revDate && <div style={s.docMeta}>{revDate}</div>}
      <div style={s.docLink}>Tap to view</div>
    </div>
  );
}

export default function OperatorWorkInstructionDashboard() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const s = getWorkInstructionStyles(t);
  const { config } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [machines, setMachines] = useState([]);
  const [stationId, setStationId] = useState(() => {
    const q = searchParams.get('station_id');
    if (q) return Number(q);
    const saved = loadDraft(DRAFT_KEYS.wiDashboard);
    return saved?.stationId ?? null;
  });
  const [machineId, setMachineId] = useState(() => {
    const q = searchParams.get('machine_id');
    if (q) return Number(q);
    const saved = loadDraft(DRAFT_KEYS.wiDashboard);
    return saved?.machineId ?? null;
  });
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showQc, setShowQc] = useState(false);
  const [showProcessSheet, setShowProcessSheet] = useState(false);
  const [pdfModal, setPdfModal] = useState(null);
  const [qcInstances, setQcInstances] = useState({});
  const [spcWarnings, setSpcWarnings] = useState([]);

  const shift = useMemo(() => getCurrentShift(config), [config]);

  const stations = useMemo(() => {
    const map = new Map();
    machines.forEach((m) => {
      if (!map.has(m.station_id)) {
        map.set(m.station_id, {
          id: m.station_id,
          name: m.station_name || `Station ${m.station_id}`,
          machines: [],
        });
      }
      map.get(m.station_id).machines.push(m);
    });
    return [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [machines]);

  const stationMachines = useMemo(
    () => machines.filter((m) => m.station_id === stationId),
    [machines, stationId],
  );

  const loadMachines = useCallback(async () => {
    try {
      const { data } = await api.get('/api/operator-dashboard/machines');
      setMachines(data);
    } catch {
      setMachines([]);
    }
  }, []);

  // Keep station/machine in sync (cascade defaults, URL/draft restore)
  useEffect(() => {
    if (!machines.length) return;

    const selected = machines.find((m) => m.id === machineId);
    if (selected) {
      if (stationId !== selected.station_id) setStationId(selected.station_id);
      return;
    }

    const qMachine = Number(searchParams.get('machine_id')) || null;
    const qStation = Number(searchParams.get('station_id')) || null;
    const saved = loadDraft(DRAFT_KEYS.wiDashboard);

    let nextMachineId = qMachine || saved?.machineId || null;
    let nextStationId = qStation || saved?.stationId || stationId || null;

    const fromUrlOrDraft = machines.find((m) => m.id === nextMachineId);
    if (fromUrlOrDraft) {
      nextStationId = fromUrlOrDraft.station_id;
    } else if (!(nextStationId && machines.some((m) => m.station_id === nextStationId))) {
      nextStationId = machines[0].station_id;
    }

    const inStation = machines.filter((m) => m.station_id === nextStationId);
    nextMachineId = inStation[0]?.id ?? machines[0].id;

    setStationId(nextStationId);
    setMachineId(nextMachineId);
  }, [machines, machineId, stationId, searchParams]);

  const loadContext = useCallback(async () => {
    if (!machineId) return;
    setLoading(true);
    try {
      const params = { machine_id: machineId };
      if (shift) params.shift = shift.id;
      const { data } = await api.get('/api/operator-dashboard/context', { params });
      setContext(data);
      if (shift && data?.entry_date) {
        try {
          const active = await api.get('/api/qc-inspection/active', {
            params: {
              machine_id: machineId,
              part_id: data.part?.id,
              shift: shift.id,
              inspection_date: data.entry_date,
            },
          });
          setQcInstances(active.data?.instances || active.data?.approval?.instances || {});
          setSpcWarnings(active.data?.spc_warnings || []);
        } catch {
          setQcInstances({});
          setSpcWarnings([]);
        }
      }
    } catch {
      setContext(null);
    } finally {
      setLoading(false);
    }
  }, [machineId, shift]);

  useEffect(() => { loadMachines(); }, [loadMachines]);
  useEffect(() => { loadContext(); }, [loadContext]);

  useEffect(() => {
    if (machineId || stationId) {
      saveDraft(DRAFT_KEYS.wiDashboard, { machineId, stationId });
    }
  }, [machineId, stationId]);

  useWebSocket((msg) => {
    const type = msg?.type;
    if ([
      'plan_started',
      'plan_updated',
      'plan_deleted',
      'machine_status',
      'machine_status_updated',
      'machine_updated',
      'breakdown_raised',
      'breakdown_acknowledged',
      'breakdown_in_progress',
      'breakdown_resolved',
      'model_change_request',
      'model_change_approved',
      'model_change_completed',
      'model_change_rejected',
    ].includes(type)) {
      // Refresh when status changes for the selected machine (or any plan/breakdown event)
      const eventMachineId = msg?.id ?? msg?.machine_id;
      if (
        eventMachineId == null
        || !machineId
        || Number(eventMachineId) === Number(machineId)
      ) {
        loadContext();
        loadMachines();
      }
    }
  });

  const syncUrl = (nextStationId, nextMachineId) => {
    const params = {};
    if (nextStationId) params.station_id = String(nextStationId);
    if (nextMachineId) params.machine_id = String(nextMachineId);
    setSearchParams(params);
  };

  const handleStationChange = (id) => {
    const nextStationId = Number(id) || null;
    const inStation = machines.filter((m) => m.station_id === nextStationId);
    const nextMachineId = inStation[0]?.id ?? null;
    setStationId(nextStationId);
    setMachineId(nextMachineId);
    syncUrl(nextStationId, nextMachineId);
  };

  const handleMachineChange = (id) => {
    const nextMachineId = Number(id) || null;
    const m = machines.find((row) => row.id === nextMachineId);
    const nextStationId = m?.station_id ?? stationId;
    setStationId(nextStationId);
    setMachineId(nextMachineId);
    syncUrl(nextStationId, nextMachineId);
  };

  const documents = useMemo(
    () => (context?.documents || []).filter((d) => d.file_url),
    [context],
  );

  const breakdownDoc = useMemo(
    () => documents.find((d) => d.doc_type === 'breakdown_sheet'),
    [documents],
  );

  const status = context?.machine?.status || 'idle';
  const statusColor = MACHINE_STATUS_COLORS[status] || '#6b7280';

  const openPdf = (url) => setPdfModal(assetUrl(url));
  const openBreakdown = () => {
    if (context?.breakdown?.sheet_url) {
      openPdf(context.breakdown.sheet_url);
    } else if (breakdownDoc?.file_url) {
      openPdf(breakdownDoc.file_url);
    } else {
      navigate('/breakdown');
    }
  };

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader
        title="WORK INSTRUCTIONS"
        onRefresh={showQc ? undefined : loadContext}
        extra={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textMuted }}>
              Station
              <select
                value={stationId || ''}
                onChange={(e) => handleStationChange(e.target.value)}
                style={s.selector}
                aria-label="Select station"
              >
                {stations.length === 0 && <option value="">No stations</option>}
                {stations.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name || `Station ${st.id}`}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textMuted }}>
              Machine
              <select
                value={machineId || ''}
                onChange={(e) => handleMachineChange(e.target.value)}
                style={s.selector}
                aria-label="Select machine"
                disabled={!stationId || stationMachines.length === 0}
              >
                {stationMachines.length === 0 && <option value="">No machines</option>}
                {stationMachines.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      />

      <div style={s.subtitle}>
        <h2 style={s.subtitleTitle}>PMS Work Instruction Docs Viewer</h2>
        {context?.server_time && (
          <div style={s.subtitleMeta}>
            {context.server_time} · Shift {context.shift}
          </div>
        )}
      </div>

      {loading && !context ? (
        <div style={s.empty}>Loading…</div>
      ) : (
        <div style={s.split}>
          <div className={surfaceClass(t)} style={s.card}>
            <div style={s.cardHdr}>Production &amp; Machine Data</div>
            <div style={s.infoGrid}>
              {[
                ['Machine No', context?.machine?.name || '—'],
                ['Station', context?.station?.display_name || '—'],
                ['Part No / Variant', context?.part?.part_no || context?.part?.model_variant || '—'],
                ['Tool No', context?.part?.tool_no || '—'],
                ['Cycle Time', context?.cycle_time ? `${formatCtSeconds(context.cycle_time)} s` : '—'],
              ].map(([label, val]) => (
                <div key={label} style={s.infoCell}>
                  <div style={s.infoLabel}>{label}</div>
                  <div style={s.infoValue}>{val}</div>
                </div>
              ))}
            </div>
            <div style={s.metricRow}>
              <div style={{ ...s.metricBox, ...s.metricBoxBorder }}>
                <div style={s.metricLabel}>Exp Output / Hour</div>
                <div style={s.metricValue}>{context?.exp_output_per_hour ?? '—'}</div>
              </div>
              <div style={s.metricBox}>
                <div style={s.metricLabel}>Exp Output / Shift</div>
                <div style={s.metricValueAlt}>{context?.exp_output_per_shift ?? '—'}</div>
              </div>
            </div>
            <div style={s.cardBody}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {Object.entries(qcInstances).map(([key, inst]) => {
                  const theme = instanceStatusTheme(inst.status || 'empty');
                  return (
                    <span
                      key={key}
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: theme.bg,
                        color: theme.color,
                        border: `1px solid ${theme.border}`,
                        fontWeight: 600,
                      }}
                    >
                      {key === 'first' ? '1st' : `H${key}`}: {INSTANCE_STATUS_LABEL[inst.status] || inst.status || '—'}
                    </span>
                  );
                })}
              </div>
              <SpcWarningBanner
                warnings={spcWarnings}
                title="SPC alert — check QC readings"
              />
              <button type="button" style={s.btnPrimary} onClick={() => setShowQc(true)}>
                QC Inspection Sheet
              </button>
              <button type="button" style={{ ...s.btnSecondary, marginLeft: 8 }} onClick={() => navigate('/qc-approvals')}>
                {['quality', 'supervisor', 'admin'].includes(user?.role) ? 'QC Approvals' : 'My QC Status'}
              </button>
            </div>
          </div>

          <div className={surfaceClass(t)} style={s.card}>
            <div style={s.cardHdr}>Work Instructions &amp; Documents</div>
            <button
              type="button"
              onClick={() => context?.part?.id && setShowProcessSheet(true)}
              disabled={!context?.part?.id}
              title={context?.part?.id ? 'Open Process Control Sheet' : 'No part linked'}
              style={{
                padding: '12px 12px 0',
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderBottom: context?.part ? `1px solid ${t.border}` : 'none',
                background: 'transparent',
                cursor: context?.part?.id ? 'pointer' : 'default',
              }}
            >
              <div style={{
                width: 100, height: 100, flexShrink: 0, borderRadius: 8,
                border: `1px solid ${t.border}`, background: t.surface2,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              }}>
                {context?.part?.image_url ? (
                  <img
                    src={assetUrl(context.part.image_url)}
                    alt={context.part.part_no || 'Part'}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <span style={{ fontSize: 28, opacity: 0.35 }}>📷</span>
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: t.text, wordBreak: 'break-word' }}>
                  {context?.part?.part_no || context?.part?.model_variant || 'No part linked'}
                </div>
                {context?.part?.part_name && (
                  <div style={{ fontSize: 12, color: t.textDim, marginTop: 2 }}>{context.part.part_name}</div>
                )}
                <div style={{ fontSize: 11, color: t.textFaint, marginTop: 4 }}>Part Image</div>
                {context?.part?.id && (
                  <div style={{ fontSize: 11, color: t.accent, marginTop: 6, fontWeight: 600 }}>
                    Click to open Process Control Sheet →
                  </div>
                )}
              </div>
            </button>
            <div style={{ ...s.cardBody, ...s.docGrid }}>
              {documents.length === 0 && (
                <div style={s.docTileEmpty}>No work instruction documents uploaded for this part</div>
              )}
              {documents.map((d) => (
                <PdfThumb
                  key={d.doc_type}
                  label={docTypeLabel(d.doc_type, d.doc_label)}
                  url={d.file_url}
                  revision={d.revision}
                  revDate={d.rev_date}
                  onOpen={() => openPdf(d.file_url)}
                  s={s}
                  t={t}
                />
              ))}
            </div>
            <div style={s.footer}>
              <div style={s.statusRow}>
                <span style={s.statusLabel}>Machine Status:</span>
                <LiveStatusButton status={status} color={statusColor} label={status} />
                <span style={{ ...s.statusText, color: statusColor }}>
                  {status.replace('_', ' ')}
                </span>
              </div>
              <button type="button" onClick={openBreakdown} style={s.breakdownBtn} title="Open breakdown sheet">
                <span style={{ fontSize: 22, lineHeight: 1 }}>🔧</span>
                Breakdown Sheet
              </button>
            </div>
          </div>
        </div>
      )}

      {showQc && (
        <QcInspectionSheet
          context={context}
          onClose={() => setShowQc(false)}
          onSubmitted={loadContext}
        />
      )}

      {showProcessSheet && context?.part && (
        <TitanModal
          title="Process Control Sheet"
          subtitle={context.part.part_no || context.part.model_variant}
          maxWidth={1200}
          onClose={() => setShowProcessSheet(false)}
          footer={(
            <button
              type="button"
              onClick={() => {
                const el = document.getElementById('process-control-sheet-print');
                if (el) {
                  printProcessControlSheet(
                    el,
                    `Process Control Sheet — ${context.part.part_no || context.part.model_variant || 'Part'}`,
                  );
                }
              }}
              style={{
                ...s.btnPrimary,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              🖨 Print Sheet
            </button>
          )}
        >
          <ProcessControlSheet
            part={context.part}
            qcParameters={context.qc_parameters || []}
            qcColumnSchema={context.qc_column_schema || []}
            machineName={context.machine?.name}
            plan={context.running_plan}
          />
        </TitanModal>
      )}

      {pdfModal && (
        <TitanModal
          title="Document Viewer"
          wide
          onClose={() => setPdfModal(null)}
        >
          {isImageDocUrl(pdfModal) ? (
            <img
              src={pdfModal}
              alt="Work instruction"
              style={{
                width: '100%',
                maxHeight: 'min(75vh, 720px)',
                objectFit: 'contain',
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                background: t.inp,
              }}
            />
          ) : (
            <iframe
              title="Document Viewer"
              src={pdfModal}
              style={{
                width: '100%',
                height: 'min(75vh, 720px)',
                border: `1px solid ${t.border}`,
                borderRadius: 8,
                background: t.inp,
              }}
            />
          )}
        </TitanModal>
      )}
    </div>
  );
}
