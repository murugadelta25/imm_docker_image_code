import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useConfig } from '../context/ConfigContext';
import TitanModal from './basic/TitanModal';
import { getWorkInstructionStyles } from '../themes/workInstructionStyles';
import {
  COL_FIRST,
  COL_OPERATOR_START,
  colToInstanceKey,
  computeShiftLayout,
  currentEditableInstance,
  INSTANCE_STATUS_LABEL,
  instanceStatusTheme,
  isCellReadOnly,
  getCellStyle,
  pendingReviewInstance,
  pendingInstanceKeys,
  instanceDisplayLabel,
  instanceKeyToCol,
  validateInstanceReadings,
  instanceSubmitLabel,
} from '../utils/qcShiftHours';
import {
  draftKey,
  clearDraft,
} from '../utils/formPersistence';
import {
  DEFAULT_QC_COLUMNS,
  normalizeQcColumnSchema,
  getParamColumnValue,
  serializeParamColumns,
} from '../utils/qcColumnSchema';
import { analyzeQcSpcWarnings } from '../utils/spcWarnings';
import SpcWarningBanner from './SpcWarningBanner';

function layoutFromReport(report, shiftStart, shiftEnd) {
  const hourSlots = report?.hour_slots || report?.approval?.hour_slots;
  return computeShiftLayout(shiftStart, shiftEnd, hourSlots?.length ? hourSlots : undefined);
}

function createEmptyReadings(paramCount, cellCount) {
  return Array.from({ length: paramCount }, () => Array(cellCount).fill(''));
}

function readingsFromReport(report, displayParams, shiftStart, shiftEnd) {
  const { cellCount } = layoutFromReport(report, shiftStart, shiftEnd);
  const saved = report?.readings || [];
  return displayParams.map((p, i) => {
    // Match by index first — parameter names are not unique (e.g. multiple "Dimension" rows)
    const row = saved[i] || null;
    const cells = row?.cells || [];
    return Array.from({ length: cellCount }, (_, c) => (cells[c] != null ? String(cells[c]) : ''));
  });
}

function applyReportToState(report, displayParams, setters, shiftStart, shiftEnd) {
  const {
    setReportId, setApprovalStatus, setApprovalMeta, setReadings, setForm,
  } = setters;
  setReportId(report.id);
  setApprovalStatus(report.status || 'draft');
  setApprovalMeta(report);
  setReadings(readingsFromReport(report, displayParams, shiftStart, shiftEnd));
  setForm((prev) => ({
    ...prev,
    article_no: report.article_no || prev.article_no,
    machine_name: report.machine_name || prev.machine_name,
    description: report.description ?? prev.description,
    operation_code: report.operation_code || prev.operation_code,
    operation_name: report.operation_name || prev.operation_name,
    production_section: report.production_section ?? prev.production_section,
    shift: report.shift || prev.shift,
    inspection_date: report.inspection_date || prev.inspection_date,
  }));
}

function CellInput({ value, onChange, s, readOnly, cellStyle }) {
  const [valueMode, setValueMode] = useState(false);

  const isCustomValue = value && !['OK', 'NOK', ''].includes(value);
  const showInput = valueMode || isCustomValue;

  const cellStyleMerged = {
    ...s.td,
    ...cellStyle,
    ...(value === 'OK' ? s.cellOk : {}),
    ...(value === 'NOK' ? s.cellNok : {}),
    ...(isCustomValue ? s.cellEdited : {}),
  };

  const inp = {
    ...s.inp,
    border: 'none',
    textAlign: 'center',
    padding: '4px',
    minWidth: 48,
    background: 'transparent',
  };

  if (readOnly) {
    return <td style={cellStyleMerged}>{value || '—'}</td>;
  }

  if (showInput) {
    return (
      <td style={cellStyleMerged}>
        <input
          type="text"
          value={value}
          style={inp}
          autoFocus={valueMode}
          placeholder="Enter value"
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            if (!value) setValueMode(false);
          }}
        />
      </td>
    );
  }

  return (
    <td style={cellStyleMerged}>
      <select
        value={['OK', 'NOK'].includes(value) ? value : ''}
        style={inp}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'VALUE') {
            setValueMode(true);
            onChange('');
          } else {
            setValueMode(false);
            onChange(v);
          }
        }}
      >
        <option value="">-</option>
        <option value="OK">OK</option>
        <option value="NOK">NOK</option>
        <option value="VALUE">Value</option>
      </select>
    </td>
  );
}

const DEFAULT_PARAMS = [
  { parameter: 'Thread', std_value: 'M37x1.5', method: 'TRG', frequency: '100%', extra_columns: [] },
  { parameter: 'Thread Length', std_value: '13.5-12.0', method: 'RG', frequency: '1pc/10', extra_columns: [] },
  { parameter: 'Inner Dia', std_value: 'Ø34.2±33.9', method: 'PG', frequency: '1pc/10', extra_columns: [] },
  { parameter: 'Total Length', std_value: '178.5-178.0', method: 'VC', frequency: '1pc/10', extra_columns: [] },
  { parameter: 'Perpendicularity', std_value: '1±0.1A', method: 'RG', frequency: '1pc/hr', extra_columns: [] },
  { parameter: 'Appearance', std_value: 'Visual', method: 'Visual', frequency: '100%', extra_columns: [] },
];

const STATUS_LABELS = {
  draft: 'Draft',
  pending_inspector: 'Awaiting Inspector',
  pending_incharge: 'Awaiting Incharge',
  approved: 'Fully Approved',
};

function fmtHm(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function QcInspectionSheet({
  context, onClose, onSubmitted, initialReportId = null, reviewingInstanceKey: reviewingProp = null,
}) {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const s = getWorkInstructionStyles(t);

  const params = context?.qc_parameters || [];
  const part = context?.part || {};
  const machine = context?.machine || {};

  const [reportId, setReportId] = useState(null);
  const [approvalStatus, setApprovalStatus] = useState('draft');
  const [approvalMeta, setApprovalMeta] = useState({});
  const [reviewingInstanceKey, setReviewingInstanceKey] = useState(reviewingProp);
  const [instances, setInstances] = useState({});

  const [form, setForm] = useState({
    article_no: part.part_no || part.model_variant || '',
    machine_name: machine.name || '',
    description: part.description || '',
    operation_code: part.operation_code || machine.name || '',
    operation_name: part.operation_name || context?.running_plan?.current_operation || '',
    production_section: part.production_section || '',
    shift: context?.shift || 'A',
    inspection_date: context?.entry_date || new Date().toLocaleDateString('en-CA'),
  });

  const displayParams = useMemo(
    () => (params.length > 0 ? params : DEFAULT_PARAMS),
    [params],
  );

  const qcColumnSchema = useMemo(
    () => normalizeQcColumnSchema(
      context?.qc_column_schema || part?.qc_column_schema,
      displayParams,
    ),
    [context?.qc_column_schema, part?.qc_column_schema, displayParams],
  );

  const shiftDef = config?.shifts?.find((sh) => sh.id === form.shift);
  const shiftStart = shiftDef?.start || '08:00';
  const shiftEnd = shiftDef?.end || '20:00';

  const shiftLayout = useMemo(() => {
    const hourSlots = approvalMeta.hour_slots
      || approvalMeta.approval?.hour_slots;
    return computeShiftLayout(shiftStart, shiftEnd, hourSlots?.length ? hourSlots : undefined);
  }, [approvalMeta, shiftStart, shiftEnd]);

  const {
    hourSlots, operatorCount, cellCount,
  } = shiftLayout;

  const approval = useMemo(() => ({
    instances,
    hour_slots: hourSlots,
    operator_slot_count: operatorCount,
  }), [instances, hourSlots, operatorCount]);

  const [readings, setReadings] = useState(() => {
    const { cellCount: cc } = computeShiftLayout(shiftStart, shiftEnd);
    return createEmptyReadings(displayParams.length, cc);
  });
  const readingsRef = useRef(readings);
  useEffect(() => { readingsRef.current = readings; }, [readings]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sheetLoaded, setSheetLoaded] = useState(false);

  const inspectionDate = form.inspection_date;
  const machineId = machine.id;
  const partId = part.id;

  const qcDraftKey = useMemo(
    () => (machineId && inspectionDate
      ? draftKey('qc', machineId, partId || 0, form.shift, inspectionDate)
      : null),
    [machineId, partId, form.shift, inspectionDate],
  );

  // Stable ref for displayParams — avoids re-running the load effect on every context refresh
  const displayParamsRef = useRef(displayParams);
  useEffect(() => { displayParamsRef.current = displayParams; }, [displayParams]);

  useEffect(() => {
    if (!machineId || !inspectionDate) {
      setSheetLoaded(true);
      return undefined;
    }
    let cancelled = false;
    setSheetLoaded(false);
    const load = initialReportId
      ? api.get(`/api/qc-inspection/${initialReportId}`)
      : api.get('/api/qc-inspection/active', {
        params: {
          machine_id: machineId,
          part_id: partId || undefined,
          shift: form.shift,
          inspection_date: inspectionDate,
        },
      });
    load.then((r) => {
      if (cancelled) return;
      const dp = displayParamsRef.current;
      const { cellCount: cc } = computeShiftLayout(shiftStart, shiftEnd);
      if (r.data) {
        // Server is the only source of truth — never merge sessionStorage over server data
        applyReportToState(r.data, dp, {
          setReportId, setApprovalStatus, setApprovalMeta, setReadings, setForm,
        }, shiftStart, shiftEnd);
        setInstances(r.data.instances || r.data.approval?.instances || {});
        if (reviewingProp) setReviewingInstanceKey(reviewingProp);
        else if (['quality', 'supervisor', 'admin'].includes(user?.role)) {
          setReviewingInstanceKey(pendingReviewInstance(r.data.approval || { instances: r.data.instances }));
        }
      } else {
        // No server report — start completely blank, clear any stale sessionStorage
        if (qcDraftKey) clearDraft(qcDraftKey);
        setReportId(null);
        setApprovalStatus('draft');
        setApprovalMeta({});
        setInstances({});
        setReadings(createEmptyReadings(dp.length, cc));
      }
      setSheetLoaded(true);
    }).catch(() => {
      if (!cancelled) setSheetLoaded(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, partId, form.shift, inspectionDate, initialReportId, reviewingProp, user?.role, shiftStart, shiftEnd, qcDraftKey]);

  const setReading = useCallback((row, col, val) => {
    setReadings((prev) => {
      const next = prev.map((r) => [...r]);
      if (!next[row]) next[row] = Array(cellCount).fill('');
      next[row][col] = val;
      return next;
    });
  }, [cellCount]);

  const buildPayload = useCallback(() => {
    const currentReadings = readingsRef.current;
    return {
      part_id: part.id || null,
      machine_id: machine.id || null,
      article_no: form.article_no,
      machine_name: form.machine_name,
      description: form.description,
      operation_code: form.operation_code,
      operation_name: form.operation_name,
      production_section: form.production_section,
      shift: form.shift,
      inspection_date: form.inspection_date,
      operator_name: user?.username || '',
      readings: displayParams.map((p, i) => {
        const cols = serializeParamColumns(p, qcColumnSchema);
        return {
          parameter: p.parameter,
          std_value: p.std_value,
          is_numeric: !!p.is_numeric,
          lsl: p.lsl != null ? Number(p.lsl) : null,
          usl: p.usl != null ? Number(p.usl) : null,
          method: cols.method,
          frequency: cols.frequency,
          extra_columns: cols.extra_columns,
          cells: currentReadings[i] || [],
        };
      }),
      approval: {
        operator_time: new Date().toTimeString().slice(0, 5),
      },
    };
  }, [part.id, machine.id, form, displayParams, user?.username, qcColumnSchema]);

  useEffect(() => {
    // Only auto-save if a report already exists (reportId set by explicit submit).
    // Never auto-create a new draft record — that causes phantom reports on every open.
    if (!sheetLoaded || approvalStatus === 'approved' || !machineId || !reportId) return undefined;
    const timer = setTimeout(() => {
      api.put('/api/qc-inspection/draft', buildPayload()).catch(() => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, [sheetLoaded, approvalStatus, machineId, reportId, buildPayload]);

  const applyLoadedReport = useCallback((report) => {
    if (!report) return;
    applyReportToState(report, displayParams, {
      setReportId, setApprovalStatus, setApprovalMeta, setReadings, setForm,
    }, shiftStart, shiftEnd);
    setInstances(report.instances || report.approval?.instances || {});
  }, [displayParams, shiftStart, shiftEnd]);

  const refreshActiveReport = useCallback(async () => {
    if (!machineId || !inspectionDate) return null;
    try {
      const { data } = await api.get('/api/qc-inspection/active', {
        params: {
          machine_id: machineId,
          part_id: partId || undefined,
          shift: form.shift,
          inspection_date: inspectionDate,
        },
      });
      if (data) {
        // Only refresh approval/instance metadata — never overwrite active readings
        setReportId(data.id);
        setApprovalStatus(data.status || 'draft');
        setApprovalMeta(data);
        setInstances(data.instances || data.approval?.instances || {});
        return data;
      }
      if (reportId) {
        const { data: byId } = await api.get(`/api/qc-inspection/${reportId}`);
        setReportId(byId.id);
        setApprovalStatus(byId.status || 'draft');
        setApprovalMeta(byId);
        setInstances(byId.instances || byId.approval?.instances || {});
        return byId;
      }
    } catch {
      /* ignore */
    }
    return null;
  }, [machineId, partId, form.shift, inspectionDate, reportId]);

  const handleClose = async () => {
    // Only save on close if a report already exists — don't create phantom drafts
    if (approvalStatus !== 'approved' && machineId && reportId) {
      try {
        await api.put('/api/qc-inspection/draft', buildPayload());
      } catch {
        /* ignore */
      }
    }
    onClose();
  };

  const handleSubmitInstance = async () => {
    setSubmitting(true);
    setError('');
    try {
      const fresh = await refreshActiveReport();
      const freshInstances = fresh?.instances || fresh?.approval?.instances || instances;
      const instKey = fresh?.current_instance
        || currentEditableInstance({ instances: freshInstances });
      if (!instKey) {
        setError('No hourly slot is open for entry right now. Missed or future hours cannot be submitted.');
        return;
      }
      // Always use current UI readings — never use server readings which may be stale
      const payload = buildPayload();
      const readingRows = payload.readings;
      const { complete, missing } = validateInstanceReadings(readingRows, displayParams, instKey, {
        instances: freshInstances,
        hour_slots: fresh?.hour_slots || fresh?.approval?.hour_slots || hourSlots,
      });
      if (!complete) {
        setError(
          `Fill all values in ${instKey === 'first' ? 'the 1st column' : `Hour ${instKey} column`} `
          + `for every parameter before submitting. Missing: ${missing.join(', ')}`,
        );
        return;
      }
      let id = fresh?.id || reportId;
      if (!id) {
        const { data: draft } = await api.put('/api/qc-inspection/draft', payload);
        id = draft.id;
        setReportId(draft.id);
      }
      const { data } = await api.post(`/api/qc-inspection/${id}/submit-instance`, {
        instance_key: instKey,
        readings: readingRows,
      });
      applyLoadedReport(data);
      setReviewingInstanceKey(null);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Failed to submit hourly inspection');
      await refreshActiveReport();
    } finally {
      setSubmitting(false);
    }
  };

  const handleInspectorApprove = async () => {
    if (!reportId) return;
    setSubmitting(true);
    setError('');
    try {
      const instKey = reviewingInstanceKey || pendingReviewInstance(approval);
      if (!instKey) {
        setError('No instance awaiting QC review');
        return;
      }
      const { data } = await api.post(`/api/qc-inspection/${reportId}/approve-inspector`, {
        instance_key: instKey,
        readings: buildPayload().readings,
      });
      applyLoadedReport(data);
      setReviewingInstanceKey(pendingReviewInstance({
        instances: data.instances || data.approval?.instances,
        hour_slots: data.hour_slots || data.approval?.hour_slots,
      }));
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Inspector approval failed');
      await refreshActiveReport();
    } finally {
      setSubmitting(false);
    }
  };

  const handleInspectorApproveAll = async () => {
    if (!reportId) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post(`/api/qc-inspection/${reportId}/approve-inspector-all`, {
        readings: buildPayload().readings,
      });
      applyLoadedReport(data);
      setReviewingInstanceKey(null);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Consolidated QC approval failed');
      await refreshActiveReport();
    } finally {
      setSubmitting(false);
    }
  };

  const handleInspectorReject = async () => {
    if (!reportId) return;
    const instKey = reviewingInstanceKey || pendingReviewInstance({ instances });
    if (!instKey) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post(`/api/qc-inspection/${reportId}/reject-instance`, {
        instance_key: instKey,
        reason: 'Rejected by inspector',
      });
      applyLoadedReport(data);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Reject failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInchargeApprove = async () => {
    if (!reportId) return;
    setSubmitting(true);
    setError('');
    try {
      const instKey = inchargeTargetKey;
      if (!instKey) {
        setError('No instance awaiting supervisor approval');
        return;
      }
      const { data } = await api.post(`/api/qc-inspection/${reportId}/approve-incharge`, {
        instance_key: instKey,
      });
      applyLoadedReport(data);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Incharge approval failed');
      await refreshActiveReport();
    } finally {
      setSubmitting(false);
    }
  };

  const handleInchargeApproveAll = async () => {
    if (!reportId) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post(`/api/qc-inspection/${reportId}/approve-incharge-all`);
      applyLoadedReport(data);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Consolidated supervisor approval failed');
      await refreshActiveReport();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseShift = async () => {
    if (!reportId) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post(`/api/qc-inspection/${reportId}/close-shift`);
      applyLoadedReport(data);
      onSubmitted?.();
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not close shift');
    } finally {
      setSubmitting(false);
    }
  };

  const ro = { ...s.inp, ...s.inpReadonly };
  const canInspector = ['quality', 'supervisor', 'admin'].includes(user?.role);
  const canIncharge = ['supervisor', 'admin'].includes(user?.role);
  const currentInstanceKey = currentEditableInstance(approval);
  const pendingInspectorCount = Object.values(instances).filter((v) => v.status === 'pending_inspector').length;
  const pendingInchargeCount = Object.values(instances).filter((v) => v.status === 'pending_incharge').length;
  const hasPendingInspector = pendingInspectorCount > 0;
  const hasPendingIncharge = pendingInchargeCount > 0;

  const inspectorBlocked = hasPendingInspector
    && canInspector
    && user?.id
    && approvalMeta.operator_id === user.id;

  const inchargeBlocked = hasPendingIncharge
    && canIncharge
    && user?.id
    && (approvalMeta.operator_id === user.id || approvalMeta.inspector_id === user.id);

  const inchargeBlockReason = inchargeBlocked
    ? (approvalMeta.operator_id === user.id
      ? 'You signed as Operator — use a different login for Supervisor'
      : 'You signed as Inspector — use a different login for Supervisor')
    : null;

  const inspectorBlockReason = inspectorBlocked
    ? 'You signed as Operator — use a different login for QC'
    : null;

  const pendingInchargeKeys = useMemo(
    () => pendingInstanceKeys(approval, 'pending_incharge'),
    [approval],
  );
  const inchargeTargetKey = reviewingInstanceKey
    || (hasPendingIncharge ? pendingInchargeKeys[0] : null);
  const inchargeTargetLabel = instanceDisplayLabel(inchargeTargetKey, hourSlots);
  const pendingInchargeLabels = pendingInchargeKeys.map((k) => instanceDisplayLabel(k, hourSlots));
  const inchargeTargetCol = inchargeTargetKey != null ? instanceKeyToCol(inchargeTargetKey, approval) : null;

  const instanceHeaderColor = (col) => {
    const key = colToInstanceKey(col, approval);
    if (!key) return {};
    if (hasPendingIncharge && canIncharge && key === inchargeTargetKey) {
      return {
        background: '#e8eaf6',
        color: '#1a237e',
        outline: '2px solid #3949ab',
        outlineOffset: -2,
      };
    }
    const st = instances[key]?.status || 'empty';
    const theme = instanceStatusTheme(st);
    if (key === currentInstanceKey && st === 'empty') {
      return { background: '#e3f2fd', color: '#1565c0' };
    }
    return { background: theme.bg, color: theme.color };
  };

  const formLocked = approvalStatus === 'approved';
  const instanceValidation = useMemo(() => {
    if (!currentInstanceKey) return { complete: false, missing: [], col: null };
    const rows = displayParams.map((p, i) => ({
      parameter: p.parameter,
      cells: readings[i] || [],
    }));
    return validateInstanceReadings(rows, displayParams, currentInstanceKey, approval);
  }, [currentInstanceKey, readings, displayParams, approval]);

  const spcWarnings = useMemo(() => {
    const readingRows = displayParams.map((p, i) => ({
      parameter: p.parameter,
      cells: readings[i] || [],
    }));
    return analyzeQcSpcWarnings(displayParams, readingRows, approval);
  }, [displayParams, readings, approval]);

  const showOperatorSubmit = currentInstanceKey
    && approvalStatus !== 'approved'
    && !reviewingInstanceKey
    && ['operator', 'admin'].includes(user?.role);

  const currentSlotLabel = currentInstanceKey === 'first'
    ? '1st piece'
    : hourSlots.find((h) => h.key === currentInstanceKey)?.label || `Hour ${currentInstanceKey}`;

  const th = s.thYellow;

  return (
    <TitanModal
      title="IN-PROCESS INSPECTION REPORT"
      subtitle="Quality Inspection Sheet — operator, inspector & incharge approval flow"
      wide
      onClose={handleClose}
      footer={(
        <>
          {error && <span style={{ ...s.error, marginRight: 'auto' }}>{error}</span>}
          {!sheetLoaded && <span style={{ marginRight: 'auto', fontSize: 12, color: t.textDim }}>Loading saved sheet…</span>}
          <button type="button" style={s.btnSecondary} onClick={handleClose}>Close</button>
          {showOperatorSubmit && (
            <button
              type="button"
              style={s.btnAccent}
              onClick={handleSubmitInstance}
              disabled={submitting || !instanceValidation.complete}
              title={!instanceValidation.complete
                ? `Complete all parameters in ${currentSlotLabel} column first`
                : undefined}
            >
              {submitting ? 'Submitting…' : instanceSubmitLabel(currentInstanceKey)}
            </button>
          )}
          {approvalStatus === 'approved' && (
            <span style={{ marginRight: 'auto', fontSize: 12, color: t.success || '#2e7d32', fontWeight: 600 }}>
              Fully approved
              {approvalMeta.incharge_username ? ` by ${approvalMeta.incharge_username}` : ''}
            </span>
          )}
          {hasPendingInspector && canInspector && !inspectorBlocked && (
            <>
              <button type="button" style={s.btnAccent} onClick={handleInspectorApprove} disabled={submitting}>
                {submitting ? 'Approving…' : 'QC Approve Instance'}
              </button>
              <button type="button" style={s.btnSecondary} onClick={handleInspectorApproveAll} disabled={submitting}>
                {submitting ? 'Approving…' : `Approve All QC (${pendingInspectorCount})`}
              </button>
              <button type="button" style={{ ...s.btnSecondary, borderColor: '#c62828', color: '#c62828' }} onClick={handleInspectorReject} disabled={submitting}>
                Reject
              </button>
            </>
          )}
          {hasPendingInspector && inspectorBlockReason && (
            <span style={{ fontSize: 12, color: t.warning || '#ed6c02', maxWidth: 280 }}>{inspectorBlockReason}</span>
          )}
          {hasPendingIncharge && canIncharge && !inchargeBlocked && (
            <>
              <span style={{
                marginRight: 8, fontSize: 12, color: t.textDim, alignSelf: 'center', maxWidth: 320,
              }}
              >
                Approving: <strong style={{ color: t.accent || '#3949ab' }}>{inchargeTargetLabel}</strong>
                {pendingInchargeCount > 1 && (
                  <span style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
                    Next of {pendingInchargeCount} pending — use Approve All Shift for consolidated sign-off
                  </span>
                )}
              </span>
              <button type="button" style={s.btnAccent} onClick={handleInchargeApprove} disabled={submitting}>
                {submitting ? 'Approving…' : `Approve ${inchargeTargetLabel}`}
              </button>
              <button type="button" style={s.btnSecondary} onClick={handleInchargeApproveAll} disabled={submitting}>
                {submitting ? 'Approving…' : `Approve All Shift (${pendingInchargeCount})`}
              </button>
              <button type="button" style={s.btnSecondary} onClick={handleCloseShift} disabled={submitting}>
                Close Shift
              </button>
            </>
          )}
          {hasPendingIncharge && inchargeBlockReason && (
            <span style={{ fontSize: 12, color: t.warning || '#ed6c02', maxWidth: 280 }}>{inchargeBlockReason}</span>
          )}
        </>
      )}
    >
      <div style={{ ...s.approvalStep, marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[
          {
            key: 'operator',
            label: '1. Operator',
            user: approvalMeta.operator_username || user?.username,
            time: fmtHm(approvalMeta.operator_approved_at),
            done: approvalStatus !== 'draft',
          },
          {
            key: 'inspector',
            label: '2. Inspector',
            user: approvalMeta.inspector_username,
            time: fmtHm(approvalMeta.inspector_approved_at),
            done: ['pending_incharge', 'approved'].includes(approvalStatus),
          },
          {
            key: 'incharge',
            label: '3. Production Incharge',
            user: approvalMeta.incharge_username,
            time: fmtHm(approvalMeta.incharge_approved_at),
            done: approvalStatus === 'approved',
          },
        ].map((step) => (
          <div
            key={step.key}
            style={{
              ...s.approvalStep,
              flex: '1 1 140px',
              ...(step.done ? s.approvalStepDone : {}),
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12 }}>{step.label}</div>
            <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
              {step.done ? `✓ ${step.user || '—'}${step.time ? ` @ ${step.time}` : ''}` : 'Pending'}
            </div>
          </div>
        ))}
        <span style={{ ...s.approvalBadge, background: t.surface2, color: t.accent, alignSelf: 'center' }}>
          {STATUS_LABELS[approvalStatus] || approvalStatus}
        </span>
      </div>

      <div style={s.section}>
        <div style={s.sectionTitle}>Basic Information</div>
        <table style={s.table}>
          <tbody>
            <tr>
              <td style={s.tdLabel}>Article No</td>
              <td style={s.td}><input value={form.article_no} readOnly style={ro} /></td>
              <td style={s.tdLabel}>Machine Name</td>
              <td style={s.td}><input value={form.machine_name} readOnly style={ro} /></td>
            </tr>
            <tr>
              <td style={s.tdLabel}>Description</td>
              <td style={s.td}>
                <input value={form.description} style={s.inp} readOnly={formLocked}
                  onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </td>
              <td style={s.tdLabel}>Operation Code</td>
              <td style={s.td}><input value={form.operation_code} readOnly style={ro} /></td>
            </tr>
            <tr>
              <td style={s.tdLabel}>Operation Name</td>
              <td style={s.td}><input value={form.operation_name} readOnly style={ro} /></td>
              <td style={s.tdLabel}>Production Section</td>
              <td style={s.td}>
                <input value={form.production_section} style={s.inp} readOnly={formLocked}
                  onChange={(e) => setForm({ ...form, production_section: e.target.value })} />
              </td>
            </tr>
            <tr>
              <td style={s.tdLabel}>Shift</td>
              <td style={s.td}>
                <select value={form.shift} style={s.inp} disabled={formLocked}
                  onChange={(e) => setForm({ ...form, shift: e.target.value })}>
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                </select>
              </td>
              <td style={s.tdLabel}>Date</td>
              <td style={s.td}><input type="date" value={form.inspection_date} readOnly style={ro} /></td>
            </tr>
            <tr>
              <td style={s.tdLabel}>Operator (logged in)</td>
              <td colSpan={3} style={s.td}>
                <input value={user?.username || ''} readOnly style={ro} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={s.section}>
        <div className="wi-qc-section-title" style={s.sectionTitleYellow}>Inspection Details</div>
        {hasPendingIncharge && canIncharge && !inchargeBlocked && (
          <div style={{
            margin: '0 0 10px',
            padding: '10px 12px',
            borderRadius: 6,
            background: '#e8eaf6',
            border: '2px solid #3949ab',
            fontSize: 12,
            color: '#1a237e',
          }}
          >
            <strong>Supervisor review</strong>
            {' — '}column highlighted in blue: <strong>{inchargeTargetLabel}</strong>
            {pendingInchargeCount > 1 && (
              <span>
                {' '}(next of {pendingInchargeCount} awaiting approval: {pendingInchargeLabels.join(', ')})
              </span>
            )}
          </div>
        )}
        {hasPendingInspector && canInspector && !inspectorBlocked && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: t.textDim }}>
            Inspector columns are <strong>optional</strong> — use them only when independent verification
            or a quality deviation requires documentation. Otherwise review operator readings and approve.
          </p>
        )}
        <SpcWarningBanner
          warnings={spcWarnings}
          title="SPC alert — review before continuing"
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8, fontSize: 11 }}>
          {['first', ...hourSlots.map((h) => h.key)].map((key) => {
            const st = instances[key]?.status || 'empty';
            const theme = instanceStatusTheme(st);
            return (
              <span
                key={key}
                style={{
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: theme.bg,
                  color: theme.color,
                  border: `1px solid ${key === inchargeTargetKey && hasPendingIncharge && canIncharge ? '#3949ab' : theme.border}`,
                  fontWeight: 600,
                  ...(key === inchargeTargetKey && hasPendingIncharge && canIncharge
                    ? { outline: '2px solid #3949ab', outlineOffset: 1 }
                    : {}),
                }}
              >
                {key === 'first' ? '1st' : `H${key}`}: {INSTANCE_STATUS_LABEL[st] || st}
              </span>
            );
          })}
        </div>
        {showOperatorSubmit && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: t.textDim }}>
            Active entry column: <strong>{currentSlotLabel}</strong>
            {!instanceValidation.complete && instanceValidation.missing?.length > 0 && (
              <span style={{ color: t.warning || '#ed6c02' }}>
                {' '}— fill all parameters in this column (missing: {instanceValidation.missing.join(', ')})
              </span>
            )}
          </p>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th className="wi-qc-th" style={th} rowSpan={2}>S.No</th>
                <th className="wi-qc-th" style={th} rowSpan={2}>Parameters</th>
                <th className="wi-qc-th" style={th} rowSpan={2}>STD</th>
                {qcColumnSchema.map((col) => (
                  <th key={col.key} className="wi-qc-th" style={th} rowSpan={2}>{col.label || col.key}</th>
                ))}
                <th className="wi-qc-th" style={{ ...th, ...instanceHeaderColor(COL_FIRST) }} rowSpan={2} title="1st piece">1st</th>
                <th className="wi-qc-th" style={th} colSpan={operatorCount}>Operator (hourly)</th>
                <th className="wi-qc-th" style={th} colSpan={2}>Inspector</th>
              </tr>
              <tr>
                {hourSlots.map((slot, idx) => (
                  <th
                    key={slot.key}
                    className="wi-qc-th"
                    style={{ ...th, ...instanceHeaderColor(COL_OPERATOR_START + idx) }}
                    title={slot.label}
                  >
                    {slot.instance}
                  </th>
                ))}
                <th className="wi-qc-th" style={th} title="QC only">1</th>
                <th className="wi-qc-th" style={th} title="QC only">2</th>
              </tr>
            </thead>
            <tbody>
              {displayParams.map((p, i) => (
                <tr key={i}>
                  <td style={s.td}>{i + 1}</td>
                  <td style={{ ...s.td, textAlign: 'left', paddingLeft: 8, fontWeight: 600 }}>{p.parameter}</td>
                  <td style={s.td}>{p.std_value}</td>
                  {qcColumnSchema.map((col) => (
                    <td key={col.key} style={s.td}>
                      {getParamColumnValue(p, col.key) || '—'}
                    </td>
                  ))}
                  {Array.from({ length: cellCount }, (_, col) => {
                    const cellValue = (readings[i] || [])[col] || '';
                    const readOnly = isCellReadOnly(
                      approval, col, cellValue, user?.role, reviewingInstanceKey,
                    );
                    const cellStyle = getCellStyle(
                      approval, col, cellValue, s, user?.role, reviewingInstanceKey,
                    );
                    const supervisorColHighlight = hasPendingIncharge && canIncharge && col === inchargeTargetCol
                      ? { boxShadow: 'inset 0 0 0 2px #3949ab', background: '#f3f4fb' }
                      : {};
                    return (
                      <CellInput
                        key={col}
                        value={cellValue}
                        onChange={(v) => setReading(i, col, v)}
                        s={s}
                        readOnly={readOnly}
                        cellStyle={{ ...cellStyle, ...supervisorColHighlight }}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {approvalStatus === 'approved' && (
        <div style={{ ...s.section, marginBottom: 0, border: `1px solid ${t.brand}` }}>
          <div style={{ ...s.sectionTitle, color: t.brand }}>Approval Complete</div>
          <p style={{ padding: 12, margin: 0, fontSize: 13, color: t.textDim }}>
            Operator: {approvalMeta.operator_username} · Inspector: {approvalMeta.inspector_username} · Incharge: {approvalMeta.incharge_username}
          </p>
        </div>
      )}
    </TitanModal>
  );
}
