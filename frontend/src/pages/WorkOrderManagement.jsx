import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import PageHeader from '../components/PageHeader';
import { pageClass, surfaceClass } from '../themes/tileHelpers';
import AddWorkOrderModal from '../components/production-planning/AddWorkOrderModal';
import WorkOrderOverview from '../components/production-planning/WorkOrderOverview';
import WorkOrderDetailPanel from '../components/production-planning/WorkOrderDetailPanel';
import { useWebSocket } from '../api/useWebSocket';

const WO_BTN_COLOR = '#7c3aed';
const WO_LINK_COLOR = '#f97316';
const STATUS_COLORS = {
  draft: '#64748b',
  in_progress: '#0ea5e9',
  completed: '#10b981',
  cancelled: '#ef4444',
};

const todayStr = () => new Date().toLocaleDateString('en-CA');

const currentWeekRange = () => {
  const d = new Date();
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { from: mon.toLocaleDateString('en-CA'), to: sun.toLocaleDateString('en-CA') };
};

const currentMonthRange = () => {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: from.toLocaleDateString('en-CA'), to: to.toLocaleDateString('en-CA') };
};

const defaultRangeForTab = (tab) => {
  if (tab === 'planned') return currentMonthRange();
  if (tab === 'active') return currentWeekRange();
  return { from: currentMonthRange().from, to: todayStr() };
};

const clampHistoricRange = (from, to) => {
  const today = todayStr();
  let f = from || today;
  let t = to || today;
  if (f > today) f = today;
  if (t > today) t = today;
  if (f > t) f = t;
  return { from: f, to: t };
};

export default function WorkOrderManagement() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('id');

  const [mainTab, setMainTab] = useState('active');
  const [workOrders, setWorkOrders] = useState([]);
  const [detail, setDetail] = useState(null);
  const [molds, setMolds] = useState([]);
  const [search, setSearch] = useState('');
  const weekDefault = currentWeekRange();
  const [dateFrom, setDateFrom] = useState(weekDefault.from);
  const [dateTo, setDateTo] = useState(weekDefault.to);
  const [appliedRange, setAppliedRange] = useState(weekDefault);
  const [appliedSearch, setAppliedSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingWo, setEditingWo] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [upcomingPlans, setUpcomingPlans] = useState([]);
  const [scheduleOnly, setScheduleOnly] = useState(null);
  const detailRef = useRef(null);

  const canCreate = user?.role !== 'maintenance';
  const canManage = canCreate;

  const fetchList = useCallback(async () => {
    const { from: rangeFrom, to: rangeTo } = appliedRange;
    setLoading(true);
    try {
      if (mainTab === 'planned') {
        const r = await api.get('/api/work-orders/planned', {
          params: {
            search: appliedSearch || undefined,
            date_from: rangeFrom,
            date_to: rangeTo,
          },
        });
        setWorkOrders(r.data.items || []);
        return;
      }
      const params = {
        search: appliedSearch || undefined,
        date_from: rangeFrom,
        date_to: rangeTo,
      };
      if (mainTab === 'historic') {
        params.status = undefined;
      } else if (mainTab === 'active') {
        params.active_only = true;
      }
      const r = await api.get('/api/work-orders/', { params });
      let list = r.data;
      if (mainTab === 'historic') {
        list = list.filter((wo) => ['completed', 'cancelled'].includes(wo.status));
      }
      setWorkOrders(list);
    } catch {
      setWorkOrders([]);
    } finally {
      setLoading(false);
    }
  }, [mainTab, appliedSearch, appliedRange]);

  const loadWithDateRange = () => {
    let from = dateFrom;
    let to = dateTo;
    if (mainTab === 'historic') {
      ({ from, to } = clampHistoricRange(from, to));
      setDateFrom(from);
      setDateTo(to);
    }
    setAppliedRange({ from, to });
    setAppliedSearch(search);
  };

  const resetToDefaultRange = () => {
    const range = defaultRangeForTab(mainTab);
    setDateFrom(range.from);
    setDateTo(range.to);
    setAppliedRange(range);
  };

  const onDateFromChange = (value) => {
    if (mainTab === 'historic') {
      const today = todayStr();
      setDateFrom(value > today ? today : value);
      return;
    }
    setDateFrom(value);
  };

  const onDateToChange = (value) => {
    if (mainTab === 'historic') {
      const today = todayStr();
      setDateTo(value > today ? today : value);
      return;
    }
    setDateTo(value);
  };

  const historicMaxDate = todayStr();

  const fetchDetail = useCallback(async (id) => {
    if (!id) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const r = await api.get(`/api/work-orders/${id}/track-record`);
      setDetail(r.data);
    } catch {
      setDetail(null);
      setMsg('❌ Could not load work order track record');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mainTab !== 'timeline') fetchList();
  }, [mainTab, appliedRange, appliedSearch, fetchList]);
  useEffect(() => { fetchDetail(selectedId); }, [selectedId, fetchDetail]);

  useEffect(() => {
    if (!selectedId) {
      setUpcomingPlans([]);
      setScheduleOnly(null);
      return;
    }
    const wo = workOrders.find((w) => String(w.id) === String(selectedId));
    setUpcomingPlans(wo?.future_plans || []);
    setScheduleOnly(wo?.schedule_only ? {
      start: wo.start_date,
      end: wo.end_date,
      unplanned_qty: wo.unplanned_qty,
      target_qty: wo.target_qty,
    } : null);
  }, [selectedId, workOrders]);

  useEffect(() => {
    if (selectedId && detail && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedId, detail]);
  useEffect(() => {
    api.get('/api/tools/', { params: { active_only: true, limit: 1000 } })
      .then((r) => setMolds(Array.isArray(r.data) ? r.data : []))
      .catch(() => setMolds([]));
  }, []);

  useWebSocket(useCallback((m) => {
    if (['work_order_created', 'work_order_updated', 'plan_created', 'plan_updated', 'plan_completed', 'actual_qty_updated'].includes(m.type)) {
      fetchList();
      if (selectedId) fetchDetail(selectedId);
    }
  }, [fetchList, fetchDetail, selectedId]));

  const selectWorkOrder = (id) => {
    if (id) {
      setSearchParams({ id: String(id) });
    } else {
      setSearchParams({});
      setDetail(null);
    }
  };

  const toggleWorkOrder = (id) => {
    if (id && String(id) === String(selectedId)) {
      selectWorkOrder(null);
    } else {
      selectWorkOrder(id);
    }
  };

  const viewTrackRecord = (id) => {
    toggleWorkOrder(id);
  };

  const openEditWo = async (wo) => {
    if (!wo?.id) return;
    try {
      const r = await api.get(`/api/work-orders/${wo.id}`);
      setEditingWo(r.data);
    } catch {
      setEditingWo(wo);
    }
    setShowAddModal(true);
  };

  const closeWoModal = () => {
    setShowAddModal(false);
    setEditingWo(null);
  };

  const deleteWorkOrder = async (wo) => {
    if (!wo?.id) return;
    const ok = window.confirm(
      `Delete work order ${wo.work_order_no}?\n\n`
      + 'Linked production plans will be unlinked (not deleted).',
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/api/work-orders/${wo.id}`);
      setMsg(`✅ Work order ${wo.work_order_no} deleted`);
      setTimeout(() => setMsg(''), 3000);
      if (String(selectedId) === String(wo.id)) selectWorkOrder(null);
      await fetchList();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    } finally {
      setDeleting(false);
    }
  };

  const pauseWorkOrderPlans = async (wo) => {
    if (!wo?.id) return;
    const running = (detail?.records || []).filter((r) => r.status === 'running');
    if (!running.length) {
      setMsg('ℹ️ No running plans to pause for this work order');
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    if (!window.confirm(`Pause ${running.length} running plan(s) for ${wo.work_order_no}?`)) return;
    setActionBusy(true);
    try {
      await Promise.all(running.map((r) => api.patch(`/api/plans/${r.plan_id}/status`, { status: 'paused' })));
      setMsg(`⏸ Paused ${running.length} plan(s)`);
      setTimeout(() => setMsg(''), 3000);
      await fetchList();
      if (selectedId) await fetchDetail(selectedId);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    } finally {
      setActionBusy(false);
    }
  };

  const abortWorkOrderPlans = async (wo) => {
    if (!wo?.id) return;
    const targets = (detail?.records || []).filter((r) => ['running', 'paused'].includes(r.status));
    if (!targets.length) {
      setMsg('ℹ️ No running/paused plans to abort for this work order');
      setTimeout(() => setMsg(''), 3000);
      return;
    }
    if (!window.confirm(
      `Abort ${targets.length} plan(s) for ${wo.work_order_no}?\n\n`
      + 'Aborted plans will not resume.',
    )) return;
    setActionBusy(true);
    try {
      await Promise.all(targets.map((r) => api.patch(`/api/plans/${r.plan_id}/status`, { status: 'aborted' })));
      setMsg(`⏹ Aborted ${targets.length} plan(s)`);
      setTimeout(() => setMsg(''), 3000);
      await fetchList();
      if (selectedId) await fetchDetail(selectedId);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    } finally {
      setActionBusy(false);
    }
  };

  const savePlanActual = async (planId, qty) => {
    try {
      await api.patch(`/api/plans/${planId}/actual`, { actual_qty: qty, source: 'manual' });
      setMsg('✅ Actual qty updated');
      setTimeout(() => setMsg(''), 3000);
      await fetchList();
      if (selectedId) await fetchDetail(selectedId);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
      throw err;
    }
  };

  const exportReport = async () => {
    try {
      const r = await api.post('/api/work-orders/export', {
        date_from: appliedRange.from,
        date_to: appliedRange.to,
        search: appliedSearch || undefined,
        historic: mainTab === 'historic',
      }, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `work_orders_${mainTab}_${new Date().toISOString().split('T')[0]}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('✅ Report downloaded');
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg('❌ Export failed: ' + (err.response?.data?.detail || err.message));
    }
  };

  const inp = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13,
  };

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader
        title="WORK ORDER MANAGEMENT"
        onRefresh={() => { fetchList(); if (selectedId) fetchDetail(selectedId); }}
        extra={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={exportReport} style={styles.exportBtn(t)} title="Download work order report">
              ⬇ Download Report
            </button>
            {canCreate && (
              <button onClick={() => { setEditingWo(null); setShowAddModal(true); }} style={styles.addWoBtn}>
                + Add Work Order
              </button>
            )}
          </div>
        }
      />

      {msg && <p style={{ color: msg.startsWith('❌') ? '#ef4444' : t.brand, fontSize: 13, marginBottom: 12 }}>{msg}</p>}

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {[
          { id: 'active', label: 'Active Work Orders' },
          { id: 'planned', label: 'Planned (Future)' },
          { id: 'historic', label: 'Historic' },
          { id: 'timeline', label: 'Timeline (Gantt)' },
        ].map((tab) => (
          <button key={tab.id} type="button"
            style={{ ...styles.tabBtn(t), ...(mainTab === tab.id ? styles.tabBtnActive(t) : {}) }}
            onClick={() => {
              const range = defaultRangeForTab(tab.id);
              setDateFrom(range.from);
              setDateTo(range.to);
              setAppliedRange(range);
              setMainTab(tab.id);
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {mainTab !== 'timeline' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
          <input style={{ ...inp, minWidth: 200 }} placeholder="Search work order, mold…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadWithDateRange()} />
          <input style={inp} type="date" value={dateFrom}
            max={mainTab === 'historic' ? historicMaxDate : undefined}
            onChange={(e) => onDateFromChange(e.target.value)} />
          <span style={{ color: t.textDim }}>to</span>
          <input style={inp} type="date" value={dateTo}
            max={mainTab === 'historic' ? historicMaxDate : undefined}
            onChange={(e) => onDateToChange(e.target.value)} />
          <button onClick={loadWithDateRange} style={{ ...inp, cursor: 'pointer', background: t.accent, color: '#fff', border: 'none' }}>
            Load
          </button>
          <button onClick={resetToDefaultRange} style={{ ...inp, cursor: 'pointer' }} title="Reset to default range for this tab">
            Default
          </button>
          <span style={{ color: t.textDim, fontSize: 12 }}>
            {mainTab === 'active' && `Active work orders · week ${appliedRange.from} → ${appliedRange.to}`}
            {mainTab === 'planned' && `Upcoming plans · ${appliedRange.from} → ${appliedRange.to}`}
            {mainTab === 'historic' && `Historic · ${appliedRange.from} → ${appliedRange.to} (up to today only)`}
          </span>
        </div>
      )}

      {showAddModal && (
        <AddWorkOrderModal
          t={t}
          molds={molds}
          editWo={editingWo}
          onClose={closeWoModal}
          onCreated={(wo) => {
            fetchList();
            selectWorkOrder(wo.id);
            setMsg(`✅ Work order ${wo.work_order_no} saved to database`);
          }}
          onUpdated={(wo) => {
            fetchList();
            if (selectedId) fetchDetail(selectedId);
            setMsg(`✅ Work order ${wo.work_order_no} updated`);
            setTimeout(() => setMsg(''), 3000);
          }}
        />
      )}

      {mainTab === 'timeline' && (
        <>
          <div className={surfaceClass(t)} style={styles.card(t)}>
            <WorkOrderOverview t={t} onViewTrackRecord={viewTrackRecord} selectedId={selectedId} />
          </div>
          {selectedId && (
            <div ref={detailRef}>
              <WorkOrderDetailPanel
                t={t}
                detail={detail}
                loading={detailLoading}
                upcomingPlans={upcomingPlans}
                scheduleOnly={scheduleOnly}
                onClose={() => selectWorkOrder(null)}
                canManage={canManage}
                onEdit={openEditWo}
                onDelete={deleteWorkOrder}
                onPause={pauseWorkOrderPlans}
                onAbort={abortWorkOrderPlans}
                deleting={deleting}
                actionBusy={actionBusy}
              />
            </div>
          )}
        </>
      )}

      {mainTab !== 'timeline' && (
        <div style={{ display: 'grid', gridTemplateColumns: selectedId ? 'minmax(280px, 1fr) minmax(320px, 1.2fr)' : '1fr', gap: 16 }}>
          <div className={surfaceClass(t)} style={styles.card(t)}>
            <h4 style={styles.cardTitle(t)}>
              {mainTab === 'historic' ? 'Historic Work Orders'
                : mainTab === 'planned' ? 'Planned Work Orders (Future)'
                  : 'Active Work Orders'} ({workOrders.length})
            </h4>
            {loading && <p style={{ color: t.textMuted, fontSize: 13 }}>Loading…</p>}
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {(mainTab === 'planned'
                      ? ['Work Order', 'Mold', 'Next Plan', 'Future Plans', 'Future Qty', 'Unplanned', 'WO Status']
                      : ['Work Order', 'Mold', 'Target', 'Completed', 'Remaining', '%', 'Status']
                    ).map((h) => (
                      <th key={h} style={styles.th(t)}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {workOrders.map((wo) => (
                    <tr key={wo.id} onClick={() => toggleWorkOrder(wo.id)}
                      style={{
                        cursor: 'pointer',
                        background: String(wo.id) === String(selectedId) ? t.surface2 : 'transparent',
                      }}>
                      <td style={styles.td(t)}>
                        <strong style={{ color: WO_LINK_COLOR }}>{wo.work_order_no}</strong>
                        {mainTab === 'planned' && wo.schedule_only && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: '#8b5cf6' }}>scheduled</span>
                        )}
                      </td>
                      <td style={styles.td(t)}>{wo.mold_label || wo.model_variant || wo.mold_name || wo.part_no || '—'}</td>
                      {mainTab === 'planned' ? (
                        <>
                          <td style={styles.td(t)}>{wo.next_plan_date || '—'}</td>
                          <td style={styles.td(t)}>{wo.future_plan_count ?? 0}</td>
                          <td style={styles.td(t)}>{wo.future_planned_qty ?? 0}</td>
                          <td style={styles.td(t)}>{wo.unplanned_qty ?? 0}</td>
                        </>
                      ) : (
                        <>
                          <td style={styles.td(t)}>{wo.target_qty}</td>
                          <td style={styles.td(t)}>{wo.completed_qty}</td>
                          <td style={styles.td(t)}>{wo.remaining_qty}</td>
                          <td style={styles.td(t)}>{wo.complete_pct}%</td>
                        </>
                      )}
                      <td style={styles.td(t)}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                          background: (STATUS_COLORS[wo.status] || '#64748b') + '22',
                          color: STATUS_COLORS[wo.status] || '#64748b',
                        }}>
                          {wo.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {workOrders.length === 0 && !loading && (
                <p style={{ textAlign: 'center', color: t.textFaint, padding: 24, fontSize: 13 }}>
                  {mainTab === 'historic' ? 'No historic work orders in this period.'
                    : mainTab === 'planned' ? 'No upcoming planned runs in this date range. Create production plans linked to a work order.'
                      : 'No active work orders. Click + Add Work Order to create one.'}
                </p>
              )}
            </div>
          </div>

          {selectedId && (
            <WorkOrderDetailPanel
              t={t}
              detail={detail}
              loading={detailLoading}
              upcomingPlans={upcomingPlans}
              scheduleOnly={scheduleOnly}
              onClose={() => selectWorkOrder(null)}
              onSaveActual={savePlanActual}
              canManage={canManage}
              onEdit={openEditWo}
              onDelete={deleteWorkOrder}
              onPause={pauseWorkOrderPlans}
              onAbort={abortWorkOrderPlans}
              deleting={deleting}
              actionBusy={actionBusy}
            />
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  addWoBtn: {
    padding: '8px 20px',
    background: WO_BTN_COLOR,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  exportBtn: (t) => ({
    padding: '8px 20px',
    background: t.brand,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  }),
  tabBtn: (t) => ({
    padding: '6px 14px',
    borderRadius: 6,
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.textMuted,
    cursor: 'pointer',
    fontSize: 13,
  }),
  tabBtnActive: (t) => ({
    background: t.accent,
    color: '#fff',
    border: `1px solid ${t.accent}`,
  }),
  card: (t) => ({
    background: t.surface,
    borderRadius: 10,
    padding: 20,
    marginBottom: 16,
  }),
  cardTitle: (t) => ({
    color: t.accent,
    margin: '0 0 14px',
    fontSize: 14,
    fontWeight: 600,
  }),
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: (t) => ({
    padding: '9px 8px',
    background: t.surface2,
    color: t.textDim,
    textAlign: 'left',
    whiteSpace: 'nowrap',
  }),
  td: (t) => ({
    padding: '8px',
    borderBottom: `1px solid ${t.border}`,
    color: t.textMuted,
    whiteSpace: 'nowrap',
  }),
};
