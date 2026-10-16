import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

const todayLocalISO = () => new Date().toISOString().split('T')[0];

const INIT = {
  work_order_no: '',
  mold_id: '',
  model_variant: '',
  description: '',
  target_qty: '',
  start_date: todayLocalISO(),
  end_date: '',
  spares_tools: [],
};

function moldLabel(m) {
  if (!m) return '';
  const bits = [m.tool_code, m.tool_name || m.mold_name];
  if (m.part_no) bits.push(m.part_no);
  return bits.filter(Boolean).join(' · ');
}

function formFromWo(editWo) {
  if (!editWo) return { ...INIT };
  return {
    work_order_no: editWo.work_order_no || '',
    mold_id: editWo.mold_id != null ? String(editWo.mold_id) : '',
    model_variant: editWo.model_variant || editWo.mold_label || '',
    description: editWo.description || '',
    target_qty: editWo.target_qty != null ? String(editWo.target_qty) : '',
    start_date: editWo.start_date || todayLocalISO(),
    end_date: editWo.end_date || '',
    spares_tools: Array.isArray(editWo.spares_tools) ? editWo.spares_tools.map((s) => ({ ...s })) : [],
  };
}

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

function moldToSpareRow(mold) {
  const qty = 1;
  const stockQty = mold.stock_qty != null ? Number(mold.stock_qty) : null;
  return {
    name: mold.tool_name || mold.mold_name || mold.tool_code,
    tool_no: mold.tool_code || null,
    qty,
    unit: mold.unit || 'pcs',
    notes: mold.part_no ? `Part: ${mold.part_no}` : null,
    stock_available: stockQty,
    remaining_qty: stockQty != null ? stockQty - qty : null,
    source: 'mold',
  };
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

export default function AddWorkOrderModal({ t, molds = [], onClose, onCreated, onUpdated, editWo = null }) {
  const navigate = useNavigate();
  const isEdit = Boolean(editWo?.id);
  const [form, setForm] = useState(() => formFromWo(editWo));
  const [spareDraft, setSpareDraft] = useState(EMPTY_DRAFT);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const inp = {
    padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13, width: '100%',
  };

  const goMoldMaster = () => {
    onClose();
    navigate('/tools');
  };

  const applyMold = (moldId) => {
    const mold = molds.find((m) => String(m.id) === String(moldId));
    if (!mold) {
      setForm((p) => ({ ...p, mold_id: '', model_variant: '', spares_tools: [] }));
      return;
    }
    const label = moldLabel(mold);
    const spare = moldToSpareRow(mold);
    setForm((p) => ({
      ...p,
      mold_id: String(moldId),
      model_variant: label,
      // Prefer mold target/shift when creating a new WO and qty still empty
      target_qty: (!isEdit && !p.target_qty && mold.target_per_shift)
        ? String(mold.target_per_shift)
        : p.target_qty,
      spares_tools: [
        spare,
        ...p.spares_tools.filter((s) => s.source !== 'mold'),
      ],
    }));
    setMsg('');
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
      if (!form.mold_id) {
        setMsg('Select a mold from mold master');
        setSaving(false);
        return;
      }
      const spares = form.spares_tools.length
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
        : null;
      if (isEdit) {
        const payload = {
          description: form.description || null,
          target_qty: parseInt(form.target_qty, 10),
          start_date: form.start_date || null,
          end_date: form.end_date || null,
          mold_id: form.mold_id ? parseInt(form.mold_id, 10) : null,
          model_variant: form.model_variant || null,
          spares_tools: spares,
        };
        const r = await api.patch(`/api/work-orders/${editWo.id}`, payload);
        onUpdated?.(r.data);
      } else {
        const payload = {
          work_order_no: form.work_order_no.trim(),
          mold_id: parseInt(form.mold_id, 10),
          model_variant: form.model_variant || null,
          description: form.description || null,
          target_qty: parseInt(form.target_qty, 10),
          start_date: form.start_date || null,
          end_date: form.end_date || null,
          spares_tools: spares,
        };
        const r = await api.post('/api/work-orders/', payload);
        onCreated?.(r.data);
      }
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
          <h3 style={{ margin: 0, color: t.accent, fontSize: 16 }}>
            {isEdit ? 'Edit Work Order' : 'Add Work Order'}
          </h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <form onSubmit={submit}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            <Field label="Work Order No. *" t={t}>
              <input style={{ ...inp, background: isEdit ? t.surface2 : t.inp }} required
                readOnly={isEdit}
                placeholder="e.g. WO-2026-07-001"
                value={form.work_order_no} onChange={(e) => setForm((p) => ({ ...p, work_order_no: e.target.value }))} />
            </Field>
            <Field label="Target Qty (pcs) *" t={t}>
              <input style={inp} type="number" min="1" required
                value={form.target_qty} onChange={(e) => setForm((p) => ({ ...p, target_qty: e.target.value }))} />
            </Field>
            <Field label="Mold *" t={t} wide>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select style={{ ...inp, flex: 1 }} required value={form.mold_id}
                  onChange={(e) => applyMold(e.target.value)}>
                  <option value="">— Select mold —</option>
                  {molds.map((m) => (
                    <option key={m.id} value={m.id}>{moldLabel(m)}</option>
                  ))}
                </select>
                <button type="button" onClick={goMoldMaster} title="Open Mold Management to add a new mold"
                  style={{
                    padding: '7px 12px', background: '#f59e0b', color: '#fff',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                    fontSize: 12, whiteSpace: 'nowrap', fontWeight: 600,
                  }}>
                  + Add Mold
                </button>
              </div>
              <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
                Work order is created against the mold master (not a part).
              </div>
            </Field>
            <Field label="Label (override)" t={t} wide>
              <input style={inp} value={form.model_variant}
                onChange={(e) => setForm((p) => ({ ...p, model_variant: e.target.value }))}
                placeholder="Defaults to mold code · name · part" />
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
                {form.mold_id && (
                  <span style={{ marginLeft: 8 }}>
                    — mold linked ({form.spares_tools.filter((s) => s.source === 'mold').length})
                  </span>
                )}
              </div>
              <button type="button" onClick={goMoldMaster}
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
                        {form.mold_id
                          ? 'No tools yet — add below'
                          : 'Select a mold to link mold master tools'}
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
                          {s.source === 'mold' && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: t.textDim }}>(mold)</span>
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

            <div style={{ color: t.textDim, fontSize: 11, marginBottom: 6 }}>Add another tool</div>
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

          {msg && <p style={{ color: msg.startsWith('Select') || msg.startsWith('No ') ? t.textDim : '#ef4444', fontSize: 13 }}>{msg}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '9px 20px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}>
              Cancel
            </button>
            <button type="submit" disabled={saving}
              style={{ padding: '9px 28px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Add Work Order')}
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
