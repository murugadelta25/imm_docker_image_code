import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { partToPlanningVariant } from '../../utils/partVariant';

const INIT = {
  work_order_no: '',
  part_id: '',
  model_variant: '',
  description: '',
  target_qty: '',
  start_date: new Date().toISOString().split('T')[0],
  end_date: '',
  spares_tools: [],
};

const EMPTY_DRAFT = {
  name: '',
  tool_no: '',
  qty: '1',
  unit: 'pcs',
  notes: '',
  stock_available: '',
};

function remainingOf(stock, required) {
  const s = stock === '' || stock == null ? null : Number(stock);
  const r = required === '' || required == null ? null : Number(required);
  if (s == null || Number.isNaN(s) || r == null || Number.isNaN(r)) return null;
  return s - r;
}

function mapPartToolsToSpares(toolsParameters, stockMap = {}) {
  const rows = toolsParameters?.rows || [];
  return rows
    .map((row) => {
      const name = (row.tools_detail || row.tool_no || '').trim();
      const toolNo = (row.tool_no || '').trim();
      if (!name && !toolNo) return null;
      const stockHit = (toolNo && stockMap[toolNo])
        || (name && stockMap[name])
        || null;
      const stockQty = stockHit != null ? Number(stockHit.stock_qty) : null;
      const qty = 1;
      return {
        name: name || toolNo,
        tool_no: toolNo || null,
        qty,
        unit: stockHit?.unit || 'pcs',
        notes: row.approx_tool_life ? `Life: ${row.approx_tool_life}` : null,
        stock_available: stockQty,
        remaining_qty: stockQty != null ? stockQty - qty : null,
        source: 'part',
      };
    })
    .filter(Boolean);
}

async function fetchStockLookup(tools) {
  const codes = [...new Set(tools.map((t) => t.tool_no).filter(Boolean))];
  const names = [...new Set(tools.map((t) => t.name).filter(Boolean))];
  if (!codes.length && !names.length) return {};
  try {
    const { data } = await api.get('/api/tools/lookup', {
      params: {
        codes: codes.join(',') || undefined,
        names: names.join(',') || undefined,
      },
    });
    return data || {};
  } catch {
    return {};
  }
}

export default function AddWorkOrderModal({ t, parts, onClose, onCreated }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(INIT);
  const [spareDraft, setSpareDraft] = useState(EMPTY_DRAFT);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingTools, setLoadingTools] = useState(false);

  const inp = {
    padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13, width: '100%',
  };

  const goAddPart = () => {
    onClose();
    navigate('/parts');
  };

  const applyPart = async (partId) => {
    const part = parts.find((p) => String(p.id) === String(partId));
    if (!part) {
      setForm((p) => ({ ...p, part_id: '', model_variant: '', spares_tools: [] }));
      return;
    }
    setForm((p) => ({
      ...p,
      part_id: String(partId),
      model_variant: partToPlanningVariant(part),
    }));
    setLoadingTools(true);
    setMsg('');
    try {
      const { data: detail } = await api.get(`/api/parts/${partId}`);
      let mapped = mapPartToolsToSpares(detail.tools_parameters);
      if (mapped.length) {
        const stockMap = await fetchStockLookup(mapped);
        mapped = mapPartToolsToSpares(detail.tools_parameters, stockMap);
      }
      setForm((p) => ({
        ...p,
        part_id: String(partId),
        model_variant: partToPlanningVariant(part),
        spares_tools: mapped,
      }));
      if (!mapped.length) {
        setMsg('No tools mapped on this part. Add tools in Part Management or add manually below.');
      }
    } catch (err) {
      setMsg(err.response?.data?.detail || err.message || 'Failed to load part tools');
      setForm((p) => ({
        ...p,
        part_id: String(partId),
        model_variant: partToPlanningVariant(part),
        spares_tools: [],
      }));
    } finally {
      setLoadingTools(false);
    }
  };

  const updateSpare = (idx, patch) => {
    setForm((p) => ({
      ...p,
      spares_tools: p.spares_tools.map((s, i) => {
        if (i !== idx) return s;
        const next = { ...s, ...patch };
        next.remaining_qty = remainingOf(next.stock_available, next.qty);
        return next;
      }),
    }));
  };

  const addSpare = async () => {
    if (!spareDraft.name.trim()) return;
    let stockAvailable = spareDraft.stock_available === '' ? null : Number(spareDraft.stock_available);
    if (stockAvailable == null || Number.isNaN(stockAvailable)) {
      const lookup = await fetchStockLookup([{
        name: spareDraft.name.trim(),
        tool_no: spareDraft.tool_no.trim() || null,
      }]);
      const hit = (spareDraft.tool_no && lookup[spareDraft.tool_no.trim()])
        || lookup[spareDraft.name.trim()];
      if (hit) stockAvailable = Number(hit.stock_qty);
    }
    const qty = spareDraft.qty === '' ? null : Number(spareDraft.qty);
    const row = {
      name: spareDraft.name.trim(),
      tool_no: spareDraft.tool_no.trim() || null,
      qty: qty != null && !Number.isNaN(qty) ? qty : null,
      unit: spareDraft.unit || 'pcs',
      notes: spareDraft.notes || null,
      stock_available: stockAvailable != null && !Number.isNaN(stockAvailable) ? stockAvailable : null,
      remaining_qty: remainingOf(stockAvailable, qty),
      source: 'manual',
    };
    setForm((p) => ({ ...p, spares_tools: [...p.spares_tools, row] }));
    setSpareDraft(EMPTY_DRAFT);
  };

  const removeSpare = (idx) => {
    setForm((p) => ({
      ...p,
      spares_tools: p.spares_tools.filter((_, i) => i !== idx),
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      const payload = {
        work_order_no: form.work_order_no.trim(),
        part_id: form.part_id ? parseInt(form.part_id, 10) : null,
        model_variant: form.model_variant || null,
        description: form.description || null,
        target_qty: parseInt(form.target_qty, 10),
        start_date: form.start_date || null,
        end_date: form.end_date || null,
        spares_tools: form.spares_tools.length
          ? form.spares_tools.map((s) => ({
              name: s.name,
              tool_no: s.tool_no || null,
              qty: s.qty !== '' && s.qty != null ? parseFloat(s.qty) : null,
              unit: s.unit || 'pcs',
              notes: s.notes || null,
              stock_available: s.stock_available != null ? Number(s.stock_available) : null,
              remaining_qty: remainingOf(s.stock_available, s.qty),
              source: s.source || null,
            }))
          : null,
      };
      const r = await api.post('/api/work-orders/', payload);
      onCreated?.(r.data);
      onClose();
    } catch (err) {
      setMsg(err.response?.data?.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  const th = {
    textAlign: 'left', padding: '6px 8px', fontSize: 11, color: t.textDim,
    borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap',
  };
  const td = { padding: '6px 8px', fontSize: 12, verticalAlign: 'middle' };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: t.surface, borderRadius: 12, padding: 24, width: '100%', maxWidth: 920,
        maxHeight: '90vh', overflow: 'auto', border: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: t.accent, fontSize: 16 }}>Add Work Order</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Work Order No. *" t={t}>
              <input style={inp} required placeholder="e.g. WO-2026-07-001"
                value={form.work_order_no} onChange={(e) => setForm((p) => ({ ...p, work_order_no: e.target.value }))} />
            </Field>
            <Field label="Target Qty (pcs) *" t={t}>
              <input style={inp} type="number" min="1" required
                value={form.target_qty} onChange={(e) => setForm((p) => ({ ...p, target_qty: e.target.value }))} />
            </Field>
            <Field label="Part / Model / Variant *" t={t} wide>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...inp, flex: 1 }} required value={form.part_id}
                  onChange={(e) => applyPart(e.target.value)}>
                  <option value="">— Select part —</option>
                  {parts.map((p) => (
                    <option key={p.id} value={p.id}>{partToPlanningVariant(p)}</option>
                  ))}
                </select>
                <button type="button" onClick={goAddPart} title="Open Part Management to add a new part"
                  style={{
                    padding: '7px 12px', background: '#059669', color: '#fff',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                    fontSize: 12, whiteSpace: 'nowrap', fontWeight: 600,
                  }}>
                  + Add Part
                </button>
              </div>
            </Field>
            <Field label="Variant (override)" t={t} wide>
              <input style={inp} value={form.model_variant}
                onChange={(e) => setForm((p) => ({ ...p, model_variant: e.target.value }))} />
            </Field>
            <Field label="Period Start" t={t}>
              <input style={inp} type="date" value={form.start_date}
                onChange={(e) => setForm((p) => ({ ...p, start_date: e.target.value }))} />
            </Field>
            <Field label="Period End" t={t}>
              <input style={inp} type="date" value={form.end_date}
                onChange={(e) => setForm((p) => ({ ...p, end_date: e.target.value }))} />
            </Field>
            <Field label="Description" t={t} wide>
              <textarea style={{ ...inp, minHeight: 60 }} maxLength={255} placeholder="Optional"
                value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
            </Field>
          </div>

          <div style={{ marginTop: 16, padding: 12, background: t.surface2, borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ color: t.textDim, fontSize: 12 }}>
                Spares / Tools
                {loadingTools && <span style={{ marginLeft: 8, color: t.accent }}>Loading from part…</span>}
                {!loadingTools && form.part_id && (
                  <span style={{ marginLeft: 8 }}>
                    — auto-loaded from Part Management ({form.spares_tools.filter((s) => s.source === 'part').length} mapped)
                  </span>
                )}
              </div>
              <button type="button" onClick={() => { onClose(); navigate('/tools'); }}
                style={{
                  padding: '5px 12px', fontSize: 11, background: '#f59e0b', color: '#fff',
                  border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600,
                }}>
                Mold Management
              </button>
            </div>

            <div style={{ overflowX: 'auto', marginBottom: 10 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={th}>Tool / Spare</th>
                    <th style={th}>Tool No</th>
                    <th style={th}>Stock Available</th>
                    <th style={th}>Required Qty</th>
                    <th style={th}>Remaining</th>
                    <th style={th}>Unit</th>
                    <th style={th} />
                  </tr>
                </thead>
                <tbody>
                  {form.spares_tools.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ ...td, color: t.textDim, textAlign: 'center' }}>
                        {form.part_id
                          ? 'No tools yet — add below or map tools on the part'
                          : 'Select a part to load mapped tools'}
                      </td>
                    </tr>
                  )}
                  {form.spares_tools.map((s, i) => {
                    const rem = remainingOf(s.stock_available, s.qty);
                    const short = rem != null && rem < 0;
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${t.border}` }}>
                        <td style={td}>
                          <span style={{ color: t.text }}>{s.name}</span>
                          {s.source === 'part' && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: t.textDim }}>(part)</span>
                          )}
                        </td>
                        <td style={{ ...td, color: t.textMuted }}>{s.tool_no || '—'}</td>
                        <td style={td}>
                          {s.stock_available != null && !Number.isNaN(Number(s.stock_available))
                            ? Number(s.stock_available)
                            : '—'}
                        </td>
                        <td style={td}>
                          <input
                            style={{ ...inp, width: 80, padding: '4px 6px' }}
                            type="number"
                            min="0"
                            step="any"
                            value={s.qty ?? ''}
                            onChange={(e) => updateSpare(i, { qty: e.target.value === '' ? null : e.target.value })}
                          />
                        </td>
                        <td style={{
                          ...td,
                          fontWeight: 600,
                          color: short ? '#ef4444' : (rem == null ? t.textMuted : '#10b981'),
                        }}>
                          {rem == null ? '—' : rem}
                        </td>
                        <td style={{ ...td, color: t.textMuted }}>{s.unit || 'pcs'}</td>
                        <td style={td}>
                          <button type="button" onClick={() => removeSpare(i)} title="Remove tool"
                            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}>
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ color: t.textDim, fontSize: 11, marginBottom: 6 }}>Add another tool (not on part)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={{ ...inp, flex: 2, minWidth: 120 }} placeholder="Name *"
                value={spareDraft.name} onChange={(e) => setSpareDraft((p) => ({ ...p, name: e.target.value }))} />
              <input style={{ ...inp, width: 100 }} placeholder="Tool No"
                value={spareDraft.tool_no} onChange={(e) => setSpareDraft((p) => ({ ...p, tool_no: e.target.value }))} />
              <input style={{ ...inp, width: 80 }} type="number" placeholder="Req qty"
                value={spareDraft.qty} onChange={(e) => setSpareDraft((p) => ({ ...p, qty: e.target.value }))} />
              <input style={{ ...inp, width: 70 }} placeholder="Unit"
                value={spareDraft.unit} onChange={(e) => setSpareDraft((p) => ({ ...p, unit: e.target.value }))} />
              <button type="button" onClick={addSpare}
                style={{ padding: '7px 14px', background: t.accent, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                + Add Tool
              </button>
            </div>
          </div>

          {msg && <p style={{ color: msg.startsWith('No tools') ? t.textDim : '#ef4444', fontSize: 13 }}>{msg}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '9px 20px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: '9px 28px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              {saving ? 'Saving…' : 'Add Work Order'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children, wide, t }) {
  return (
    <div style={{ gridColumn: wide ? 'span 2' : 'span 1', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ color: t.textDim, fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}
