import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { assetUrl } from '../api/config';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { getWorkInstructionStyles } from '../themes/workInstructionStyles';
import {
  DEFAULT_QC_COLUMNS,
  normalizeQcColumnSchema,
  getParamColumnValue,
  setParamColumnValue,
  emptyParamFromSchema,
  serializeParamColumns,
} from '../utils/qcColumnSchema';
import {
  DEFAULT_TOOLS_COLUMNS,
  DEFAULT_MACHINE_PARAM_COLUMNS,
  DEFAULT_JIGS_COLUMNS,
  emptyParamTable,
  normalizeParamTable,
  emptyRowFromColumns,
  serializeParamTable,
} from '../utils/paramTableSchema';
import { MAX_IMAGE_BYTES, validateFileSize, validateWiDocFile, WI_DOC_ACCEPT } from '../utils/uploadLimits';
import {
  OTHER_DOC_TYPE,
  mergeDocTypes,
  resolveDocTypeSelection,
  docTypeLabel,
} from '../utils/docTypes';
import SymbolInput, { isSpecColumn } from '../components/SymbolInput';

const PARTS_PAGE_SIZE = 50;

const PARAMETER_PRESETS = [
  'Dimension', 'Chamfer', 'Symmetry', 'Appearance', 'Surface Finish',
  'Thread', 'Thread Length', 'Inner Dia', 'Outer Dia', 'Total Length',
  'Perpendicularity', 'Hardness', 'Weight', 'Visual',
];

const MANUFACTURING_STATUS_OPTIONS = [
  { value: 'prototype', label: 'Prototype' },
  { value: 'pre-launch', label: 'Pre-Launch' },
  { value: 'production', label: 'Production' },
  { value: 'other', label: 'Other' },
];

const EMPTY_PART = {
  part_no: '',
  part_name: '',
  model_variant: '',
  description: '',
  tool_no: '',
  production_section: '',
  input_material: '',
  previous_operation: '',
  next_operation: '',
  machine_type: '',
  operation_code: '',
  operation_name: '',
  operation_sequence_steps: [''],
  process_time: '',
  loading_unloading: '10',
  drawing_revision: '',
  manufacturing_status: 'production',
  manufacturing_status_other: '',
  qc_column_schema: [...DEFAULT_QC_COLUMNS],
  qc_parameters: [],
  tools_parameters: emptyParamTable(DEFAULT_TOOLS_COLUMNS),
  machine_parameters: emptyParamTable(DEFAULT_MACHINE_PARAM_COLUMNS),
  jigs_fixtures: emptyParamTable(DEFAULT_JIGS_COLUMNS),
  cycle_profile: null,
};

const DOC_TYPES = [
  { key: 'control_plan', label: 'Control Plan' },
  { key: 'wi_visual', label: 'WI-Visual' },
  { key: 'wi_tray', label: 'WI-Tray' },
  { key: 'breakdown_sheet', label: 'Breakdown Sheet' },
];

const DOC_LABEL_BY_KEY = Object.fromEntries(DOC_TYPES.map((d) => [d.key, d.label]));

const SEQ_ARROW = '→';

function parseOperationSequence(raw) {
  if (raw == null || !String(raw).trim()) return [''];
  const steps = String(raw)
    .split(/\s*(?:→|➔|->|—>|›)\s*/)
    .map((s) => s.replace(/^\d+\)\s*/, '').trim())
    .filter(Boolean);
  return steps.length ? steps : [''];
}

function joinOperationSequence(steps) {
  return (steps || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(` ${SEQ_ARROW} `);
}

/** Safe value for controlled type="number" inputs — avoids React NaN warnings. */
function toNumberInputValue(val, fallback = '') {
  if (val === '' || val == null) return fallback;
  const n = Number(val);
  return Number.isNaN(n) ? fallback : String(val);
}

function normalizeQcParamRow(q, seqNo) {
  return {
    seq_no: seqNo,
    parameter: q.parameter || '',
    std_value: q.std_value || '',
    is_numeric: !!q.is_numeric,
    lsl: toNumberInputValue(q.lsl),
    usl: toNumberInputValue(q.usl),
    method: q.method || '',
    frequency: q.frequency || '',
    extra_columns: (q.extra_columns || []).map((c) => ({ ...c })),
  };
}

function partFormFromApi(p, { includeImages = true } = {}) {
  return {
    part_no: includeImages ? (p.part_no || '') : '',
    part_name: p.part_name || '',
    model_variant: includeImages ? (p.model_variant || p.part_no || '') : '',
    description: p.description || '',
    tool_no: p.tool_no || '',
    production_section: p.production_section || '',
    input_material: p.input_material || '',
    previous_operation: p.previous_operation || '',
    next_operation: p.next_operation || '',
    machine_type: p.machine_type || '',
    operation_code: p.operation_code || '',
    operation_name: p.operation_name || '',
    operation_sequence_steps: parseOperationSequence(p.operation_sequence),
    process_time: toNumberInputValue(p.process_time),
    loading_unloading: toNumberInputValue(p.loading_unloading, '10'),
    drawing_revision: p.drawing_revision || '',
    manufacturing_status: p.manufacturing_status || 'production',
    manufacturing_status_other: p.manufacturing_status_other || '',
    image_url: includeImages ? (p.image_url || '') : '',
    sketch_image_url: includeImages ? (p.sketch_image_url || '') : '',
    qc_column_schema: normalizeQcColumnSchema(p.qc_column_schema, p.qc_parameters),
    qc_parameters: (p.qc_parameters || []).map((q, i) => normalizeQcParamRow(q, i + 1)),
    tools_parameters: normalizeParamTable(p.tools_parameters, DEFAULT_TOOLS_COLUMNS),
    machine_parameters: normalizeParamTable(p.machine_parameters, DEFAULT_MACHINE_PARAM_COLUMNS),
    jigs_fixtures: normalizeParamTable(p.jigs_fixtures, DEFAULT_JIGS_COLUMNS),
    active: includeImages ? (p.active ?? 1) : 1,
    cycle_profile: p.cycle_profile || null,
  };
}

function PartThumbImage({ url, alt, style, placeholder }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return placeholder;
  return (
    <img
      src={assetUrl(url)}
      alt={alt || ''}
      style={style}
      onError={() => setBroken(true)}
    />
  );
}

function ImageUploadBox({
  label, url, alt, t, s, selectedId, onUpload, placeholderIcon = '📷',
}) {
  return (
    <div style={{ flexShrink: 0 }}>
      <div style={{
        width: 120, height: 120, borderRadius: 10,
        border: `2px dashed ${url ? t.brand : t.border}`,
        background: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', marginBottom: 6,
      }}
      >
        {url ? (
          <PartThumbImage
            url={url}
            alt={alt}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            placeholder={<span style={{ fontSize: 32, opacity: 0.3, color: t.textDim }}>{placeholderIcon}</span>}
          />
        ) : (
          <span style={{ fontSize: 32, opacity: 0.3, color: t.textDim }}>{placeholderIcon}</span>
        )}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.text, marginBottom: 4 }}>{label}</div>
      {selectedId ? (
        <>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }}
            style={{ fontSize: 11, maxWidth: 130 }}
          />
          <div style={{ fontSize: 10, color: t.textFaint }}>Max 2 MB</div>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 11, color: t.textDim }}>Save part first</p>
      )}
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen = true, headerExtra, children, t, s, summary }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      marginBottom: 16,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      background: t.surface2,
      overflow: 'hidden',
    }}
    >
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        padding: '10px 12px',
        background: t.surface,
        borderBottom: open ? `1px solid ${t.border}` : 'none',
      }}
      >
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 13, color: t.text }}>{title}</strong>
          {!open && summary && (
            <div style={{ fontSize: 11, color: t.textDim, marginTop: 2 }}>{summary}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {open && headerExtra}
          <button type="button" onClick={() => setOpen((v) => !v)} style={open ? s.btnHide : s.btnShow}>
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {open && (
        <div style={{ padding: 12 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DynamicParamTable({
  title, table, onChange, t, s, inp, defaultOpen = true,
}) {
  const columns = table?.columns || [];
  const rows = table?.rows || [];

  const updateColumnLabel = (key, label) => {
    onChange({
      ...table,
      columns: columns.map((c) => (c.key === key ? { ...c, label } : c)),
    });
  };

  const addColumn = () => {
    const key = `col_${Date.now()}`;
    onChange({
      columns: [...columns, { key, label: '' }],
      rows: rows.map((r) => ({ ...r, [key]: '' })),
    });
  };

  const removeColumn = (key) => {
    if (columns.length <= 1) return;
    onChange({
      columns: columns.filter((c) => c.key !== key),
      rows: rows.map((r) => {
        const next = { ...r };
        delete next[key];
        return next;
      }),
    });
  };

  const addRow = () => {
    onChange({
      ...table,
      rows: [...rows, emptyRowFromColumns(columns)],
    });
  };

  const updateCell = (rowIdx, key, val) => {
    const nextRows = [...rows];
    nextRows[rowIdx] = { ...nextRows[rowIdx], [key]: val };
    onChange({ ...table, rows: nextRows });
  };

  const removeRow = (rowIdx) => {
    onChange({
      ...table,
      rows: rows.filter((_, i) => i !== rowIdx),
    });
  };

  return (
    <CollapsibleSection
      title={title}
      defaultOpen={defaultOpen}
      t={t}
      s={s}
      summary={`${rows.length} row(s) · ${columns.length} column(s)`}
      headerExtra={(
        <button type="button" onClick={addRow} style={s.btnAddRow}>+ Add Row</button>
      )}
    >
      <div style={{
        marginBottom: 10, padding: 10, borderRadius: 8,
        border: `1px solid ${t.border}`, background: t.surface,
      }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
            Columns (rename or add — shared by all rows)
          </span>
          <button type="button" onClick={addColumn} style={s.btnAddColumn}>+ Add Column</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {columns.map((col) => (
            <div
              key={col.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 8px', borderRadius: 6, border: `1px solid ${t.border}`,
                background: t.surface2,
              }}
            >
              <input
                value={col.label || ''}
                onChange={(e) => updateColumnLabel(col.key, e.target.value)}
                placeholder="Column name"
                style={{ ...inp, width: 140, fontSize: 11 }}
              />
              {columns.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeColumn(col.key)}
                  style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: t.textDim }}
                  title="Remove column"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }}>#</th>
              {columns.map((col) => (
                <th key={col.key} className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }}>
                  {col.label || col.key}
                </th>
              ))}
              <th className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} style={{ padding: 8, color: t.textDim, fontSize: 12 }}>
                  No rows yet — click + Add Row
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={i}>
                <td style={{ padding: 4 }}>{i + 1}</td>
                {columns.map((col) => (
                  <td key={col.key} style={{ padding: 4, minWidth: isSpecColumn(col) || col.key === 'tools_detail' ? 160 : undefined }}>
                    {isSpecColumn(col) || col.key === 'tools_detail' ? (
                      <SymbolInput
                        value={row[col.key] ?? ''}
                        onChange={(val) => updateCell(i, col.key, val)}
                        style={inp}
                        placeholder={col.label || col.key}
                        t={t}
                        title="Insert ± / GD&T symbols"
                      />
                    ) : (
                      <input
                        value={row[col.key] ?? ''}
                        onChange={(e) => updateCell(i, col.key, e.target.value)}
                        style={inp}
                        placeholder={col.label || col.key}
                      />
                    )}
                  </td>
                ))}
                <td style={{ padding: 4 }}>
                  <button type="button" onClick={() => removeRow(i)} style={{ cursor: 'pointer' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

export default function PartManagement() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [parts, setParts] = useState([]);
  const [partsTotal, setPartsTotal] = useState(0);
  const [partsPage, setPartsPage] = useState(1);
  const [partsPages, setPartsPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [partDocuments, setPartDocuments] = useState([]);
  const [docTypeOptions, setDocTypeOptions] = useState([]);
  const [docUploadOpen, setDocUploadOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_PART });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [copySourceLabel, setCopySourceLabel] = useState(null);

  const s = getWorkInstructionStyles(t);

  const loadParts = useCallback(async (page = 1, search = '') => {
    setListLoading(true);
    try {
      const { data } = await api.get('/api/parts/', {
        params: {
          active_only: false,
          page,
          page_size: PARTS_PAGE_SIZE,
          search: search.trim() || undefined,
        },
      });
      setParts(data.items || []);
      setPartsTotal(data.total ?? 0);
      setPartsPage(data.page ?? page);
      setPartsPages(data.pages ?? 1);
    } catch {
      setParts([]);
      setPartsTotal(0);
      setMsg('Failed to load parts — ensure database migration has been run');
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDocTypes = useCallback(async () => {
    try {
      const { data } = await api.get('/api/parts/document-types');
      setDocTypeOptions(mergeDocTypes(data, partDocuments));
    } catch {
      setDocTypeOptions(mergeDocTypes([], partDocuments));
    }
  }, [partDocuments]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadParts(1, searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, loadParts]);

  useEffect(() => {
    loadDocTypes();
  }, [loadDocTypes]);

  const applyFullPart = (p) => {
    setSelectedId(p.id);
    setCopySourceLabel(null);
    setPartDocuments(p.documents || []);
    setDocUploadOpen(false);
    setForm(partFormFromApi(p, { includeImages: true }));
    setMsg('');
  };

  const applyCopyAsNew = (p, sourceLabel) => {
    setSelectedId(null);
    setPartDocuments([]);
    setDocUploadOpen(false);
    setCopySourceLabel(sourceLabel || p.part_no || 'part');
    const copied = partFormFromApi(p, { includeImages: false });
    setForm({
      ...copied,
      part_no: '',
      model_variant: '',
      image_url: '',
      sketch_image_url: '',
      active: 1,
    });
    setMsg(`Copied from ${sourceLabel || p.part_no} — enter a new Part No, adjust fields, then Save Part`);
  };

  const copyPartAndEdit = async (partId = selectedId) => {
    if (!partId) {
      setMsg('Select a part to copy');
      return;
    }
    try {
      const { data } = await api.get(`/api/parts/${partId}`);
      applyCopyAsNew(data, data.part_no);
    } catch {
      setMsg('Failed to load part for copy');
    }
  };

  const copyPartFromList = async (e, summary) => {
    e.stopPropagation();
    await copyPartAndEdit(summary.id);
  };

  const selectPart = async (summary) => {
    try {
      const { data } = await api.get(`/api/parts/${summary.id}`);
      applyFullPart(data);
    } catch {
      setMsg('Failed to load part details');
    }
  };

  const newPart = () => {
    setSelectedId(null);
    setCopySourceLabel(null);
    setPartDocuments([]);
    setDocUploadOpen(false);
    setForm({
      ...EMPTY_PART,
      qc_column_schema: [...DEFAULT_QC_COLUMNS],
      qc_parameters: [],
      tools_parameters: emptyParamTable(DEFAULT_TOOLS_COLUMNS),
      machine_parameters: emptyParamTable(DEFAULT_MACHINE_PARAM_COLUMNS),
      jigs_fixtures: emptyParamTable(DEFAULT_JIGS_COLUMNS),
    });
    setMsg('');
  };

  const addQcRow = () => {
    setForm((f) => {
      const schema = f.qc_column_schema || DEFAULT_QC_COLUMNS;
      const blank = emptyParamFromSchema(schema);
      return {
        ...f,
        qc_parameters: [
          ...f.qc_parameters,
          {
            seq_no: f.qc_parameters.length + 1,
            parameter: '',
            std_value: '',
            is_numeric: false,
            lsl: '',
            usl: '',
            ...blank,
          },
        ],
      };
    });
  };

  const updateQcColumnLabel = (key, label) => {
    setForm((f) => ({
      ...f,
      qc_column_schema: (f.qc_column_schema || []).map((c) => (
        c.key === key ? { ...c, label } : c
      )),
    }));
  };

  const addQcColumn = () => {
    const key = `col_${Date.now()}`;
    setForm((f) => ({
      ...f,
      qc_column_schema: [...(f.qc_column_schema || DEFAULT_QC_COLUMNS), { key, label: '' }],
      qc_parameters: f.qc_parameters.map((q) => setParamColumnValue(q, key, '')),
    }));
  };

  const removeQcColumn = (key) => {
    if (key === 'method' || key === 'frequency') return;
    setForm((f) => ({
      ...f,
      qc_column_schema: (f.qc_column_schema || []).filter((c) => c.key !== key),
      qc_parameters: f.qc_parameters.map((q) => ({
        ...q,
        extra_columns: (q.extra_columns || []).filter((c) => c.key !== key),
      })),
    }));
  };

  const updateQcColumnValue = (rowIdx, key, val) => {
    setForm((f) => {
      const qc = [...f.qc_parameters];
      qc[rowIdx] = setParamColumnValue(qc[rowIdx], key, val);
      return { ...f, qc_parameters: qc };
    });
  };

  const updateQc = (idx, field, val) => {
    setForm((f) => {
      const qc = [...f.qc_parameters];
      const row = { ...qc[idx], [field]: val };
      if (field === 'is_numeric' && !val) {
        row.lsl = '';
        row.usl = '';
      }
      qc[idx] = row;
      return { ...f, qc_parameters: qc };
    });
  };

  const removeQc = (idx) => {
    setForm((f) => ({
      ...f,
      qc_parameters: f.qc_parameters.filter((_, i) => i !== idx).map((q, i) => ({ ...q, seq_no: i + 1 })),
    }));
  };

  const validateParamTableColumns = (table, title) => {
    for (const col of table?.columns || []) {
      if (!col.label?.trim()) {
        return `All ${title} column names must be filled in`;
      }
    }
    return null;
  };

  const savePart = async () => {
    if (!form.part_no.trim()) {
      setMsg('Part number is required');
      return;
    }
    if (form.manufacturing_status === 'other' && !form.manufacturing_status_other?.trim()) {
      setMsg('Enter manufacturing status type when Other is selected');
      return;
    }
    for (const q of form.qc_parameters) {
      if (q.is_numeric && (q.lsl === '' || q.lsl == null || q.usl === '' || q.usl == null)) {
        setMsg(`LSL and USL are required for numeric parameter "${q.parameter || '(unnamed)'}"`);
        return;
      }
    }
    for (const col of form.qc_column_schema || []) {
      if (!col.label?.trim()) {
        setMsg('All QC column names must be filled in');
        return;
      }
    }
    for (const [table, title] of [
      [form.tools_parameters, 'Tools Parameters'],
      [form.machine_parameters, 'Machine Parameters'],
      [form.jigs_fixtures, 'Jigs, Fixtures & Gauges'],
    ]) {
      const err = validateParamTableColumns(table, title);
      if (err) {
        setMsg(err);
        return;
      }
    }
    setSaving(true);
    setMsg('');
    try {
      const payload = {
        part_no: form.part_no,
        part_name: form.part_name,
        model_variant: form.part_no,
        description: form.description || null,
        tool_no: form.tool_no || null,
        production_section: form.production_section || null,
        input_material: form.input_material,
        previous_operation: form.previous_operation,
        next_operation: form.next_operation,
        machine_type: form.machine_type,
        operation_code: form.operation_code,
        operation_name: form.operation_name,
        operation_sequence: joinOperationSequence(form.operation_sequence_steps) || null,
        process_time: form.process_time === '' ? null : Number(form.process_time),
        loading_unloading: Number(form.loading_unloading) || 10,
        drawing_revision: form.drawing_revision,
        manufacturing_status: form.manufacturing_status || 'production',
        manufacturing_status_other: form.manufacturing_status === 'other'
          ? form.manufacturing_status_other
          : null,
        active: form.active ?? 1,
        qc_column_schema: form.qc_column_schema || DEFAULT_QC_COLUMNS,
        qc_parameters: form.qc_parameters.map((q, i) => {
          const cols = serializeParamColumns(q, form.qc_column_schema);
          return {
            seq_no: i + 1,
            parameter: q.parameter,
            std_value: q.std_value,
            is_numeric: !!q.is_numeric,
            lsl: q.is_numeric && q.lsl !== '' ? Number(q.lsl) : null,
            usl: q.is_numeric && q.usl !== '' ? Number(q.usl) : null,
            method: cols.method,
            frequency: cols.frequency,
            extra_columns: cols.extra_columns,
          };
        }),
        tools_parameters: serializeParamTable(form.tools_parameters),
        machine_parameters: serializeParamTable(form.machine_parameters),
        jigs_fixtures: serializeParamTable(form.jigs_fixtures),
        cycle_profile: form.cycle_profile || null,
      };
      if (selectedId) {
        await api.put(`/api/parts/${selectedId}`, payload);
        setMsg('Part updated');
      } else {
        const { data } = await api.post('/api/parts/', payload);
        setSelectedId(data.id);
        applyFullPart(data);
        setCopySourceLabel(null);
        setMsg('Part created');
      }
      await loadParts(partsPage, searchQuery);
    } catch (e) {
      setMsg(e.response?.data?.detail || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const uploadImage = async (file) => {
    if (!selectedId || !file) return;
    const sizeErr = validateFileSize(file, MAX_IMAGE_BYTES, 'Image');
    if (sizeErr) {
      setMsg(sizeErr);
      return;
    }
    setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/api/parts/${selectedId}/image`, fd);
      setMsg('File uploaded successfully — part image');
      await loadParts(partsPage, searchQuery);
      const updated = (await api.get(`/api/parts/${selectedId}`)).data;
      applyFullPart(updated);
    } catch (e) {
      setMsg(e.response?.data?.detail || 'Image upload failed');
    }
  };

  const uploadSketch = async (file) => {
    if (!selectedId || !file) return;
    const sizeErr = validateFileSize(file, MAX_IMAGE_BYTES, 'Sketch image');
    if (sizeErr) {
      setMsg(sizeErr);
      return;
    }
    setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/api/parts/${selectedId}/sketch`, fd);
      setMsg('File uploaded successfully — part sketch');
      await loadParts(partsPage, searchQuery);
      const updated = (await api.get(`/api/parts/${selectedId}`)).data;
      applyFullPart(updated);
    } catch (e) {
      setMsg(e.response?.data?.detail || 'Sketch upload failed');
    }
  };

  const uploadDoc = async (docType, file, revision, revDate, docLabel) => {
    if (!selectedId || !file) return { ok: false };
    const sizeErr = validateWiDocFile(file);
    if (sizeErr) {
      setMsg(sizeErr);
      return { ok: false, message: sizeErr };
    }
    setMsg('');
    const label = docLabel || DOC_LABEL_BY_KEY[docType] || docTypeLabel(docType);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const params = { revision: revision || '0', doc_label: label };
      if (revDate) params.rev_date = revDate;
      await api.post(`/api/parts/${selectedId}/documents/${docType}/upload`, fd, { params });
      const success = `File uploaded successfully — ${label} (Rev ${revision || '0'})`;
      setMsg(success);
      await loadParts(partsPage, searchQuery);
      const updated = (await api.get(`/api/parts/${selectedId}`)).data;
      applyFullPart(updated);
      await loadDocTypes();
      return { ok: true, message: success };
    } catch (e) {
      const err = e.response?.data?.detail || 'Document upload failed';
      setMsg(err);
      return { ok: false, message: err };
    }
  };

  const inp = { ...s.inp };

  const textFields = [
    ['part_name', 'Part Name'],
    ['part_no', 'Part No / Article No'],
    ['input_material', 'Input Material'],
    ['operation_name', 'Operation Name'],
    ['previous_operation', 'Previous Operation'],
    ['next_operation', 'Next Operation'],
    ['machine_type', 'Machine Type'],
    ['operation_code', 'Operation Number / Code'],
    ['process_time', 'Process Time (s)', 'number'],
    ['loading_unloading', 'Loading/Unloading (s)', 'number'],
    ['drawing_revision', 'Part / Drawing Revision'],
  ];

  return (
    <div className={pageClass(t)} style={s.page}>
      <datalist id="param-presets">
        {PARAMETER_PRESETS.map((p) => <option key={p} value={p} />)}
      </datalist>

      <PageHeader title="Part Management Master" onRefresh={() => loadParts(partsPage, searchQuery)} extra={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => navigate('/work-orders')} style={s.btnSecondary}
            title="Go to Work Order Management">
            Work Orders
          </button>
          <button type="button" onClick={newPart} style={s.btnSecondary}>+ New Part</button>
        </div>
      } />

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
        <div style={{ ...s.card, padding: 10, maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13, color: t.accent }}>Parts Knowledge Base</div>
          <input
            type="search"
            placeholder="Search part no, name…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ ...inp, marginBottom: 8, fontSize: 12 }}
          />
          <div style={{ fontSize: 11, color: t.textDim, marginBottom: 6 }}>
            {listLoading ? 'Loading…' : `${partsTotal} part(s) · page ${partsPage} of ${partsPages}`}
          </div>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {parts.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'stretch',
                marginBottom: 4,
                gap: 4,
              }}
            >
            <button
              type="button"
              onClick={() => selectPart(p)}
              style={{
                display: 'flex', gap: 10, alignItems: 'center', flex: 1, textAlign: 'left',
                padding: '8px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: selectedId === p.id && !copySourceLabel ? `${t.brand}22` : 'transparent',
                color: p.active ? t.text : t.textFaint,
                fontSize: 13,
              }}
            >
              <div style={{
                width: 44, height: 44, flexShrink: 0, borderRadius: 6,
                border: `1px solid ${t.border}`, background: t.surface2,
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              }}>
                {p.image_url ? (
                  <PartThumbImage
                    url={p.image_url}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    placeholder={<span style={{ fontSize: 18, opacity: 0.35 }}>📷</span>}
                  />
                ) : (
                  <span style={{ fontSize: 18, opacity: 0.35 }}>📷</span>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{p.part_no}</div>
                {(p.qc_parameter_preview || p.qc_parameters || []).length > 0 && (
                  <div style={{ fontSize: 10, color: t.textFaint, marginTop: 2 }}>
                    QC: {(p.qc_parameter_preview || (p.qc_parameters || []).map((q) => q.parameter))
                      .filter(Boolean).join(', ')}
                    {p.qc_param_count > (p.qc_parameter_preview?.length || 0) && '…'}
                  </div>
                )}
              </div>
            </button>
            <button
              type="button"
              title={`Copy ${p.part_no} as new part`}
              onClick={(e) => copyPartFromList(e, p)}
              style={{
                flexShrink: 0,
                width: 32,
                borderRadius: 6,
                border: `1px solid ${t.border}`,
                background: t.surface2,
                cursor: 'pointer',
                fontSize: 14,
                color: t.textDim,
              }}
            >
              ⧉
            </button>
            </div>
          ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'space-between' }}>
            <button
              type="button"
              style={s.btnSecondary}
              disabled={partsPage <= 1 || listLoading}
              onClick={() => loadParts(partsPage - 1, searchQuery)}
            >
              ← Prev
            </button>
            <button
              type="button"
              style={s.btnSecondary}
              disabled={partsPage >= partsPages || listLoading}
              onClick={() => loadParts(partsPage + 1, searchQuery)}
            >
              Next →
            </button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 10, color: t.textFaint }}>
            WI docs: PDF max 5 MB · JPEG/PNG/SVG max 2 MB · part/sketch image max 2 MB
          </p>
        </div>

        <div style={{ ...s.card, padding: 16 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
            <ImageUploadBox
              label="Part Image"
              url={form.image_url}
              alt={form.part_no || 'Part'}
              t={t}
              s={s}
              selectedId={selectedId}
              onUpload={uploadImage}
            />
            <ImageUploadBox
              label="Part Sketch"
              url={form.sketch_image_url}
              alt={`${form.part_no || 'Part'} sketch`}
              t={t}
              s={s}
              selectedId={selectedId}
              onUpload={uploadSketch}
              placeholderIcon="📐"
            />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <h3 style={{ margin: 0, fontSize: 16, color: t.text }}>
                  {selectedId
                    ? 'Edit Part'
                    : copySourceLabel
                      ? `New Part (copied from ${copySourceLabel})`
                      : 'New Part'}
                </h3>
                {selectedId && (
                  <button
                    type="button"
                    onClick={() => copyPartAndEdit()}
                    style={s.btnSecondary}
                    title="Duplicate this part as a new record"
                  >
                    Copy &amp; Edit as New
                  </button>
                )}
              </div>
              {copySourceLabel && !selectedId && (
                <p style={{ margin: '0 0 8px', fontSize: 12, color: t.warning || '#ed6c02' }}>
                  Process sheet fields and parameter tables were copied. Enter a unique Part No, then save.
                  Images and PDFs are not copied — upload after saving.
                </p>
              )}
              <p style={{ margin: 0, fontSize: 12, color: t.textDim }}>
                Machine Name is assigned on the Planning dashboard. Enter Machine Type here (e.g. VMC, CNC).
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            {textFields.map(([key, label, type]) => (
              <label key={key} style={{ fontSize: 12, color: t.textDim }}>
                {label}
                <input
                  type={type || 'text'}
                  value={type === 'number' ? toNumberInputValue(form[key], key === 'loading_unloading' ? '10' : '') : (form[key] ?? '')}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  style={{ ...inp, marginTop: 4 }}
                  placeholder={
                    key === 'operation_code' ? 'e.g. OP20, OP30, OP40'
                      : key === 'machine_type' ? 'e.g. VMC(Rotary), CNC'
                        : key === 'part_name' ? 'e.g. BIT ROD'
                          : undefined
                  }
                />
              </label>
            ))}
            <label style={{ fontSize: 12, color: t.textDim }}>
              Manufacturing Status
              <select
                value={form.manufacturing_status || 'production'}
                onChange={(e) => setForm({
                  ...form,
                  manufacturing_status: e.target.value,
                  manufacturing_status_other: e.target.value === 'other' ? form.manufacturing_status_other : '',
                })}
                style={{ ...inp, marginTop: 4 }}
              >
                {MANUFACTURING_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {form.manufacturing_status === 'other' && (
              <label style={{ fontSize: 12, color: t.textDim }}>
                Manufacturing Status (Other)
                <input
                  type="text"
                  value={form.manufacturing_status_other || ''}
                  onChange={(e) => setForm({ ...form, manufacturing_status_other: e.target.value })}
                  style={{ ...inp, marginTop: 4 }}
                  placeholder="Enter status type"
                />
              </label>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: t.textDim, marginBottom: 6 }}>Operation Sequence</div>
            <OperationSequenceEditor
              steps={form.operation_sequence_steps || ['']}
              onChange={(operation_sequence_steps) => setForm({ ...form, operation_sequence_steps })}
              t={t}
              s={s}
              inp={inp}
            />
            <div style={{ fontSize: 11, color: t.textFaint, marginTop: 6 }}>
              Preview: {joinOperationSequence(form.operation_sequence_steps) || '—'}
            </div>
          </div>

          <DynamicParamTable
            title="TOOLS PARAMETERS"
            table={form.tools_parameters}
            onChange={(tools_parameters) => setForm({ ...form, tools_parameters })}
            t={t}
            s={s}
            inp={inp}
            defaultOpen={false}
          />

          <DynamicParamTable
            title="MACHINE PARAMETERS"
            table={form.machine_parameters}
            onChange={(machine_parameters) => setForm({ ...form, machine_parameters })}
            t={t}
            s={s}
            inp={inp}
            defaultOpen={false}
          />

          <DynamicParamTable
            title="JIGS, FIXTURES & GAUGES"
            table={form.jigs_fixtures}
            onChange={(jigs_fixtures) => setForm({ ...form, jigs_fixtures })}
            t={t}
            s={s}
            inp={inp}
            defaultOpen={false}
          />

          <CollapsibleSection
            title="QC PARAMETERS / INSPECTION PARAMETERS (shown on WI / QC sheet)"
            defaultOpen={false}
            t={t}
            s={s}
            summary={`${form.qc_parameters.length} parameter(s)`}
            headerExtra={(
              <button type="button" onClick={addQcRow} style={s.btnAddRow}>+ Add Row</button>
            )}
          >
            <div style={{
              marginBottom: 10, padding: 10, borderRadius: 8,
              border: `1px solid ${t.border}`, background: t.surface,
            }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: t.text }}>
                  Spec columns (shared by all parameters — rename for each customer)
                </span>
                <button type="button" onClick={addQcColumn} style={s.btnAddColumn}>+ Add Column</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(form.qc_column_schema || DEFAULT_QC_COLUMNS).map((col) => (
                  <div
                    key={col.key}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 8px', borderRadius: 6, border: `1px solid ${t.border}`,
                      background: t.surface2,
                    }}
                  >
                    <input
                      value={col.label || ''}
                      onChange={(e) => updateQcColumnLabel(col.key, e.target.value)}
                      placeholder="Column name"
                      style={{ ...inp, width: 160, fontSize: 11 }}
                    />
                    {col.key !== 'method' && col.key !== 'frequency' && (
                      <button
                        type="button"
                        onClick={() => removeQcColumn(col.key)}
                        style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: t.textDim }}
                        title="Remove column"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p style={{ margin: '8px 0 0', fontSize: 11, color: t.textDim }}>
                Defaults match Process Control Sheet: Inspection Method, Operator/Inspector frequency, Control Method.
                Check Points map to Parameter; Specifications map to STD.
              </p>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['#', 'Check Points (Parameter)', 'Specifications (STD)', 'Num', 'LSL', 'USL'].map((h) => (
                      <th key={h} className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }}>{h}</th>
                    ))}
                    {(form.qc_column_schema || DEFAULT_QC_COLUMNS).map((col) => (
                      <th key={col.key} className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }}>
                        {col.label || col.key}
                      </th>
                    ))}
                    <th className="wi-qc-th" style={{ ...s.thYellow, padding: 6 }} />
                  </tr>
                </thead>
                <tbody>
                  {form.qc_parameters.map((q, i) => (
                    <tr key={i}>
                      <td style={{ padding: 4 }}>{i + 1}</td>
                      <td style={{ padding: 4 }}>
                        <input list="param-presets" value={q.parameter || ''}
                          onChange={(e) => updateQc(i, 'parameter', e.target.value)} style={inp}
                          placeholder="e.g. Dimension, Chamfer" />
                      </td>
                      <td style={{ padding: 4, minWidth: 180 }}>
                        <SymbolInput
                          value={q.std_value || ''}
                          onChange={(val) => updateQc(i, 'std_value', val)}
                          style={inp}
                          placeholder="e.g. 30.3 ± 0.05 or ⌀4.0"
                          t={t}
                          title="Insert ± / GD&T symbols"
                        />
                      </td>
                      <td style={{ padding: 4, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={!!q.is_numeric}
                          onChange={(e) => updateQc(i, 'is_numeric', e.target.checked)}
                          title="Numeric value — enter LSL/USL for SPC"
                        />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input
                          type="number"
                          step="any"
                          value={toNumberInputValue(q.lsl)}
                          disabled={!q.is_numeric}
                          onChange={(e) => updateQc(i, 'lsl', e.target.value)}
                          style={{ ...inp, opacity: q.is_numeric ? 1 : 0.45 }}
                          placeholder="LSL"
                        />
                      </td>
                      <td style={{ padding: 4 }}>
                        <input
                          type="number"
                          step="any"
                          value={toNumberInputValue(q.usl)}
                          disabled={!q.is_numeric}
                          onChange={(e) => updateQc(i, 'usl', e.target.value)}
                          style={{ ...inp, opacity: q.is_numeric ? 1 : 0.45 }}
                          placeholder="USL"
                        />
                      </td>
                      {(form.qc_column_schema || DEFAULT_QC_COLUMNS).map((col) => (
                        <td key={col.key} style={{ padding: 4 }}>
                          <input
                            value={getParamColumnValue(q, col.key)}
                            onChange={(e) => updateQcColumnValue(i, col.key, e.target.value)}
                            style={inp}
                            placeholder={col.label || col.key}
                          />
                        </td>
                      ))}
                      <td style={{ padding: 4 }}>
                        <button type="button" onClick={() => removeQc(i)} style={{ cursor: 'pointer' }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>

          {selectedId && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13 }}>Work Instruction Documents</strong>
                <button
                  type="button"
                  onClick={() => setDocUploadOpen((v) => !v)}
                  style={s.btnSecondary}
                >
                  {docUploadOpen ? 'Cancel' : '+ Upload Document'}
                </button>
              </div>
              {docUploadOpen && (
                <DocUploadPanel
                  t={t}
                  s={s}
                  docTypeOptions={docTypeOptions.length ? docTypeOptions : DOC_TYPES}
                  partDocuments={partDocuments}
                  onUpload={(key, label, file, rev, date) => uploadDoc(key, file, rev, date, label)}
                  onClose={() => setDocUploadOpen(false)}
                />
              )}
              {partDocuments.length === 0 ? (
                <p style={{ margin: docUploadOpen ? '10px 0 0' : 0, fontSize: 12, color: t.textDim }}>
                  No documents uploaded yet. Click Upload Document to add one.
                </p>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 10,
                  marginTop: docUploadOpen ? 10 : 0,
                }}
                >
                  {partDocuments.map((d) => (
                    <div
                      key={d.id || d.doc_type}
                      style={{
                        border: `1px solid ${t.border}`, borderRadius: 8, padding: 10,
                        fontSize: 12, background: t.surface2,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: t.text }}>
                        {docTypeLabel(d.doc_type, d.doc_label || DOC_LABEL_BY_KEY[d.doc_type], docTypeOptions)}
                      </div>
                      <div style={{ color: t.textDim, marginTop: 4 }}>
                        Rev {d.revision} · {d.rev_date || '—'}
                      </div>
                      <div style={{ marginTop: 6, fontWeight: 600, color: '#16a34a' }}>
                        ✓ Document uploaded
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <CollapsibleSection
            title="CYCLE PROFILE (Multi-Segment Cycle Stitching)"
            defaultOpen={false}
            t={t}
            s={s}
            summary={form.cycle_profile?.interruptions > 0
              ? `${form.cycle_profile.interruptions} interruption(s) · threshold ${form.cycle_profile.micro_run_threshold_sec || 0}s`
              : 'Disabled'}
          >
            <CycleProfileEditor
              profile={form.cycle_profile}
              onChange={cp => setForm(f => ({ ...f, cycle_profile: cp }))}
              t={t}
              inp={inp}
            />
          </CollapsibleSection>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button type="button" onClick={savePart} disabled={saving} style={s.btnAccent}>
              {saving ? 'Saving…' : selectedId ? 'Update Part' : 'Save Part'}
            </button>
            {msg && (
              <span style={{
                fontSize: 13,
                fontWeight: 600,
                color: msg.toLowerCase().includes('fail') || msg.includes('required') || msg.includes('must') || msg.includes('Enter ') ? '#dc2626' : '#16a34a',
              }}
              >
                {msg.toLowerCase().includes('success') || msg.includes('uploaded') ? '✓ ' : ''}{msg}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OperationSequenceEditor({ steps, onChange, t, s, inp }) {
  const list = steps?.length ? steps : [''];

  const updateStep = (idx, val) => {
    const next = [...list];
    next[idx] = val;
    onChange(next);
  };

  const addStep = () => {
    onChange([...list, '']);
  };

  const removeStep = (idx) => {
    if (list.length <= 1) {
      onChange(['']);
      return;
    }
    onChange(list.filter((_, i) => i !== idx));
  };

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 8,
      padding: 10,
      borderRadius: 8,
      border: `1px solid ${t.border}`,
      background: t.surface2,
    }}
    >
      {list.map((step, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {idx > 0 && (
            <span style={{
              color: t.accent,
              fontWeight: 800,
              fontSize: 18,
              lineHeight: 1,
              userSelect: 'none',
            }}
            >
              {SEQ_ARROW}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="text"
              value={step}
              onChange={(e) => updateStep(idx, e.target.value)}
              placeholder={idx === 0 ? 'e.g. Turning' : 'Next process'}
              style={{ ...inp, width: 140, marginTop: 0 }}
            />
            {list.length > 1 && (
              <button
                type="button"
                title="Remove step"
                onClick={() => removeStep(idx)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: t.textDim,
                  cursor: 'pointer',
                  fontSize: 14,
                  padding: 2,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
      <button type="button" onClick={addStep} style={s.btnSecondary}>
        + Add
      </button>
    </div>
  );
}

function CycleProfileEditor({ profile, onChange, t, inp }) {
  const enabled = !!(profile?.interruptions > 0);
  const interruptions = profile?.interruptions ?? 0;
  const threshold = profile?.micro_run_threshold_sec ?? 0;
  const label = profile?.label ?? '';

  const update = (patch) => {
    const next = { interruptions, micro_run_threshold_sec: threshold, label, ...(profile || {}), ...patch };
    onChange(next.interruptions > 0 ? next : null);
  };

  // Build visual pattern preview
  const patternParts = [];
  if (threshold > 0) patternParts.push(`Run(≤${threshold}s)`);
  for (let i = 0; i < Math.min(interruptions, 6); i++) {
    patternParts.push('Ld/UnLd');
    patternParts.push(i === interruptions - 1 ? 'Run ✓' : 'Run');
  }
  const pattern = patternParts.join(' → ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 12, color: t.textDim }}>
        Define how many loading/unloading interruptions occur inside one complete part cycle
        (e.g. repositioning for VMC multi-angle operations). When enabled, the Loss Tracker
        will merge these segments into a single logical cycle for accurate count and duration.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12, color: t.textDim }}>
          Interruptions per cycle
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <input type="number" min="0" max="20"
              value={interruptions}
              onChange={e => update({ interruptions: Math.max(0, parseInt(e.target.value) || 0) })}
              style={{ ...inp, width: 80 }}
            />
            <span style={{ fontSize: 11, color: t.textFaint }}>(0 = disabled)</span>
          </div>
        </label>

        <label style={{ fontSize: 12, color: t.textDim }}>
          Micro-run threshold (s)
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <input type="number" min="0" max="120"
              value={threshold}
              onChange={e => update({ micro_run_threshold_sec: Math.max(0, parseInt(e.target.value) || 0) })}
              style={{ ...inp, width: 80 }}
            />
            <span style={{ fontSize: 11, color: t.textFaint }}>Running ≤ this = setup move</span>
          </div>
        </label>

        <label style={{ fontSize: 12, color: t.textDim }}>
          Profile label
          <input type="text"
            value={label}
            onChange={e => update({ label: e.target.value })}
            placeholder="e.g. 3-position VMC"
            style={{ ...inp, marginTop: 4, minWidth: 180 }}
          />
        </label>
      </div>

      {interruptions > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: 8, background: '#8b5cf611',
                      border: '1px solid #8b5cf644', fontSize: 12 }}>
          <span style={{ fontWeight: 700, color: '#8b5cf6', marginRight: 8 }}>Pattern preview:</span>
          <span style={{ color: t.text, fontFamily: 'monospace' }}>{pattern || '—'}</span>
          <div style={{ marginTop: 6, fontSize: 11, color: t.textFaint }}>
            {interruptions} Ld/UnLd break{interruptions > 1 ? 's' : ''} → {interruptions + 1} Running segment{interruptions > 1 ? 's' : ''} merged into 1 cycle
          </div>
        </div>
      )}
    </div>
  );
}

function DocUploadPanel({ t, s, docTypeOptions, partDocuments, onUpload, onClose }) {
  const [docTypeKey, setDocTypeKey] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [rev, setRev] = useState('0');
  const [revDate, setRevDate] = useState(new Date().toISOString().slice(0, 10));
  const [uploading, setUploading] = useState(false);
  const [rowMsg, setRowMsg] = useState('');
  const [file, setFile] = useState(null);
  const fileInputRef = useRef(null);

  const resolvedKey = docTypeKey === OTHER_DOC_TYPE ? null : docTypeKey;
  const current = resolvedKey
    ? partDocuments.find((d) => d.doc_type === resolvedKey)
    : null;

  const handleUpload = async () => {
    const resolved = resolveDocTypeSelection(docTypeKey, customLabel);
    if (resolved.error) {
      setRowMsg(resolved.error);
      return;
    }
    if (!file) {
      setRowMsg('Choose a file (PDF, JPEG, PNG, or SVG)');
      return;
    }
    const sizeErr = validateWiDocFile(file);
    if (sizeErr) {
      setRowMsg(sizeErr);
      return;
    }
    setUploading(true);
    setRowMsg('');
    const result = await onUpload(resolved.key, resolved.label, file, rev, revDate);
    setUploading(false);
    if (result?.ok) {
      setRowMsg('Document uploaded');
      setFile(null);
      setCustomLabel('');
      setDocTypeKey('');
      setRev('0');
      if (fileInputRef.current) fileInputRef.current.value = '';
      setTimeout(() => {
        onClose?.();
      }, 900);
    } else if (result?.message) {
      setRowMsg(result.message);
    }
  };

  const rowOk = rowMsg && (
    rowMsg === 'Document uploaded'
    || rowMsg.toLowerCase().includes('success')
    || rowMsg.toLowerCase().includes('uploaded')
  ) && !rowMsg.toLowerCase().includes('fail');

  return (
    <div style={{
      width: '100%',
      boxSizing: 'border-box',
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 14,
      fontSize: 12,
      background: t.surface2,
    }}
    >
      <div style={{ fontWeight: 600, marginBottom: 10, color: t.text }}>Upload Document</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: t.textDim, gridColumn: '1 / -1' }}>
          Document Type *
          <select
            value={docTypeKey}
            onChange={(e) => setDocTypeKey(e.target.value)}
            style={{ ...s.inp, marginTop: 4 }}
          >
            <option value="">Select type…</option>
            {docTypeOptions.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
            <option value={OTHER_DOC_TYPE}>Other (new type)…</option>
          </select>
        </label>
        {docTypeKey === OTHER_DOC_TYPE && (
          <label style={{ fontSize: 12, color: t.textDim, gridColumn: '1 / -1' }}>
            New Document Type Name *
            <input
              type="text"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="e.g. Process Sheet Revision"
              style={{ ...s.inp, marginTop: 4 }}
            />
          </label>
        )}
        <label style={{ fontSize: 12, color: t.textDim }}>
          Revision
          <input type="text" value={rev} onChange={(e) => setRev(e.target.value)} style={{ ...s.inp, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: t.textDim }}>
          Revision Date
          <input type="date" value={revDate} onChange={(e) => setRevDate(e.target.value)} style={{ ...s.inp, marginTop: 4 }} />
        </label>
      </div>
      {current && (
        <div style={{ color: t.textDim, marginBottom: 8 }}>
          Current: Rev {current.revision} · {current.rev_date || '—'} — will be archived on upload
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={WI_DOC_ACCEPT}
        disabled={uploading || !docTypeKey}
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        style={{ width: '100%', fontSize: 11, marginBottom: 6 }}
      />
      <div style={{ fontSize: 10, color: t.textDim, marginBottom: 10 }}>
        PDF, JPEG, PNG, or SVG (PDF max 5 MB, images max 2 MB)
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={handleUpload}
          disabled={uploading || !docTypeKey || !file}
          style={s.btnAccent}
        >
          {uploading ? 'Uploading…' : 'Upload Document'}
        </button>
        <button type="button" onClick={onClose} style={s.btnSecondary} disabled={uploading}>
          Cancel
        </button>
        {rowMsg && (
          <span style={{
            fontWeight: 600,
            color: rowOk ? '#16a34a' : '#dc2626',
          }}
          >
            {rowOk ? '✓ ' : ''}{rowMsg}
          </span>
        )}
      </div>
    </div>
  );
}
