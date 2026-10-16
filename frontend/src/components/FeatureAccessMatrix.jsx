import { useEffect, useMemo, useRef, useState, Fragment } from 'react';
import api from '../api/client';
import { useTheme } from '../context/ThemeContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import {
  getAccessMatrixRoleDefaults,
  mergeAccessMatrixRoles,
  normalizeAccessMatrixFromApi,
} from '../config/accessMatrix';

const FALLBACK_ROLE_CFG = {
  superadmin:  { color: '#dc2626', label: 'Super Admin', icon: '🛡' },
  admin:       { color: '#ef4444', label: 'Admin', icon: '⚙' },
  site_admin:  { color: '#f97316', label: 'Site Admin', icon: '🏭' },
  supervisor:  { color: '#f59e0b', label: 'Supervisor', icon: '📋' },
  operator:    { color: '#0ea5e9', label: 'Operator', icon: '🔧' },
  maintenance: { color: '#10b981', label: 'Maintenance', icon: '🛠' },
  quality:     { color: '#8b5cf6', label: 'Quality', icon: '✓' },
};

function permissionType(row) {
  if (row.kind === 'edit') return { text: 'EDIT', color: '#0ea5e9', hint: 'Create / change records on this screen' };
  if (row.kind === 'action') return { text: 'ACTION', color: '#f59e0b', hint: 'Specific button (raise, approve, ack, resolve…)' };
  return { text: 'VIEW', color: '#10b981', hint: 'Show this page in the sidebar (read-only unless EDIT/ACTION is also ticked)' };
}

function rolesMapFromEmpty(slugs) {
  return Object.fromEntries(slugs.map((s) => [s, false]));
}

/**
 * Editable Feature Access Matrix — persists via PUT /api/features/role-access.
 * Does not wipe featureModules or other SiteConfig keys (backend merges).
 */
export default function FeatureAccessMatrix({ onFlash }) {
  const { theme: t } = useTheme();
  const {
    roleAccess,
    accessMatrix: apiMatrix,
    toggleableRoles,
    roles: appRoles,
    reload: reloadFeatures,
  } = useFeatureFlags();

  const [roleAccessEdit, setRoleAccessEdit] = useState({});
  const [roleAccessSaving, setRoleAccessSaving] = useState(false);
  const [copyFromRole, setCopyFromRole] = useState('');
  const [copyToRole, setCopyToRole] = useState('');
  const [matrixHighlightRole, setMatrixHighlightRole] = useState(null);
  const matrixTableRef = useRef(null);

  const roleSlugs = useMemo(
    () => mergeAccessMatrixRoles(toggleableRoles),
    [toggleableRoles],
  );

  const roleCfgMap = useMemo(() => {
    const out = { ...FALLBACK_ROLE_CFG };
    for (const r of appRoles || []) {
      out[r.slug] = {
        color: r.color || '#64748b',
        label: r.label || r.slug,
        icon: r.icon || '👤',
      };
    }
    return out;
  }, [appRoles]);

  const matrixRows = useMemo(
    () => normalizeAccessMatrixFromApi(apiMatrix, roleSlugs),
    [apiMatrix, roleSlugs],
  );

  useEffect(() => {
    const defaults = getAccessMatrixRoleDefaults(roleSlugs);
    const merged = {};
    const ids = new Set([
      ...Object.keys(defaults),
      ...Object.keys(roleAccess || {}),
      ...matrixRows.map((row) => row.id),
    ]);
    for (const id of ids) {
      const row = matrixRows.find((r) => r.id === id || r.registryId === id);
      const base = {
        ...rolesMapFromEmpty(roleSlugs),
        ...(row?.roles || {}),
        ...(defaults[id] || {}),
        ...((roleAccess || {})[id] || {}),
      };
      merged[id] = base;
    }
    setRoleAccessEdit(merged);
  }, [roleAccess, matrixRows, roleSlugs]);

  const flash = (text, ok = true) => {
    if (onFlash) onFlash(text, ok);
  };

  const toggleFeatureRole = (featureId, role) => {
    setRoleAccessEdit((prev) => {
      const current = { ...(prev[featureId] || {}) };
      const enabled = !current[role];
      const next = { ...prev };
      const setOne = (id, value) => {
        const cur = { ...(next[id] || {}) };
        cur[role] = value;
        next[id] = cur;
        const r = matrixRows.find((x) => x.id === id);
        if (r?.registryId && r.registryId !== id) next[r.registryId] = { ...cur };
      };
      setOne(featureId, enabled);
      const row = matrixRows.find((r) => r.id === featureId);
      if (row?.kind === 'page' && !enabled) {
        for (const child of matrixRows.filter((r) => r.parentId === featureId)) {
          setOne(child.id, false);
        }
      }
      if (row?.parentId && enabled) {
        setOne(row.parentId, true);
      }
      return next;
    });
  };

  const setRoleForAllFeatures = (role, enabled) => {
    setRoleAccessEdit((prev) => {
      const next = { ...prev };
      for (const row of matrixRows) {
        const current = { ...(next[row.id] || { ...row.roles }) };
        current[role] = enabled;
        next[row.id] = current;
        if (row.registryId && row.registryId !== row.id) {
          next[row.registryId] = { ...current };
        }
      }
      return next;
    });
  };

  const setAllRolesForFeature = (featureId, enabled) => {
    setRoleAccessEdit((prev) => {
      const next = { ...prev };
      const setAll = (id, value) => {
        const current = { ...(next[id] || {}) };
        for (const role of roleSlugs) current[role] = value;
        next[id] = current;
        const row = matrixRows.find((r) => r.id === id);
        if (row?.registryId && row.registryId !== id) next[row.registryId] = { ...current };
      };
      setAll(featureId, enabled);
      const row = matrixRows.find((r) => r.id === featureId);
      if (row?.kind === 'page' && !enabled) {
        for (const child of matrixRows.filter((r) => r.parentId === featureId)) {
          setAll(child.id, false);
        }
      }
      if (row?.parentId && enabled) {
        setAll(row.parentId, true);
      }
      return next;
    });
  };

  const applyCopyRoleAccess = () => {
    if (!copyFromRole || !copyToRole || copyFromRole === copyToRole) {
      flash('Choose two different roles to copy', false);
      return;
    }
    setRoleAccessEdit((prev) => {
      const next = { ...prev };
      for (const row of matrixRows) {
        const current = { ...(next[row.id] || { ...row.roles }) };
        current[copyToRole] = !!current[copyFromRole];
        next[row.id] = current;
        if (row.registryId && row.registryId !== row.id) {
          next[row.registryId] = { ...current };
        }
      }
      return next;
    });
    flash(`Copied ticks from ${roleCfgMap[copyFromRole]?.label || copyFromRole} → ${roleCfgMap[copyToRole]?.label || copyToRole}`);
  };

  const resetRoleAccessToDefaults = () => {
    setRoleAccessEdit(getAccessMatrixRoleDefaults(roleSlugs));
    flash('Reset to registry defaults (not saved yet)');
  };

  const saveRoleAccess = async () => {
    setRoleAccessSaving(true);
    try {
      const payload = {};
      for (const row of matrixRows) {
        if (roleAccessEdit[row.id]) payload[row.id] = roleAccessEdit[row.id];
        if (row.registryId && roleAccessEdit[row.registryId]) {
          payload[row.registryId] = roleAccessEdit[row.registryId];
        }
      }
      await api.put('/api/features/role-access', { roleAccess: payload });
      await reloadFeatures();
      flash('✅ Feature access matrix saved');
    } catch (e) {
      flash('❌ ' + (e.response?.data?.detail || e.message || 'Failed to save role access'), false);
    } finally {
      setRoleAccessSaving(false);
    }
  };

  const s = {
    card: { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 },
    cardTitle: { color: t.accent, margin: '0 0 14px', fontSize: 14, fontWeight: 600 },
    inp: {
      padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
      background: t.inp, color: t.text, fontSize: 13, minWidth: 140,
    },
    outlineBtn: {
      padding: '8px 16px', background: 'transparent', color: t.accent,
      border: `1px solid ${t.accent}`, borderRadius: 8, cursor: 'pointer', fontSize: 13,
    },
    submitBtn: {
      padding: '8px 22px', background: t.brand || t.accent, color: '#fff', border: 'none',
      borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14,
    },
    cancelBtn: {
      padding: '8px 18px', background: 'transparent', color: t.textMuted,
      border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', fontSize: 13,
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: {
      padding: '10px', background: t.surface2, color: t.textDim,
      textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600,
    },
    stickyHead: { position: 'sticky', top: 0, boxShadow: `0 1px 0 ${t.border}` },
    stickyFeature: {
      left: 0, width: 260, minWidth: 260, maxWidth: 260,
      boxShadow: `1px 0 0 ${t.border}`, whiteSpace: 'normal',
    },
    stickyPerm: {
      left: 260, minWidth: 96, width: 96,
      boxShadow: `1px 0 0 ${t.border}`,
    },
    td: { padding: '10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' },
  };

  return (
    <div style={s.card}>
      <h4 style={s.cardTitle}>📋 Feature Access Matrix</h4>
      <p style={{ color: t.textMuted, fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>
        Tick VIEW / EDIT / ACTION per role, then <strong>Save access matrix</strong>.
        Child rows (↳) are actions under the page above — not separate menu items.
        Existing site settings and feature modules are preserved when you save.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        {[
          { text: 'VIEW', color: '#10b981', desc: 'Show the page in the sidebar' },
          { text: 'EDIT', color: '#0ea5e9', desc: 'Create / change (Save Entry, plans…)' },
          { text: 'ACTION', color: '#f59e0b', desc: 'Specific button (Approve, Raise…)' },
        ].map((chip) => (
          <div
            key={chip.text}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', borderRadius: 8,
              border: `1px solid ${chip.color}66`, background: `${chip.color}14`,
              fontSize: 12, color: t.text, maxWidth: 360,
            }}
          >
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.04em', color: chip.color }}>{chip.text}</span>
            <span style={{ color: t.textMuted }}>{chip.desc}</span>
          </div>
        ))}
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center',
        justifyContent: 'space-between', marginBottom: 12,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 12, color: t.textMuted }}>
          <span>Copy ticks</span>
          <select style={s.inp} value={copyFromRole} onChange={(e) => setCopyFromRole(e.target.value)}>
            <option value="">From role…</option>
            {roleSlugs.map((slug) => (
              <option key={slug} value={slug}>{roleCfgMap[slug]?.label || slug}</option>
            ))}
          </select>
          <span>onto</span>
          <select style={s.inp} value={copyToRole} onChange={(e) => setCopyToRole(e.target.value)}>
            <option value="">To role…</option>
            {roleSlugs.map((slug) => (
              <option key={slug} value={slug}>{roleCfgMap[slug]?.label || slug}</option>
            ))}
          </select>
          <button type="button" style={s.outlineBtn} onClick={applyCopyRoleAccess}>Apply copy</button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={s.cancelBtn} onClick={resetRoleAccessToDefaults} disabled={roleAccessSaving}>
            Reset to defaults
          </button>
          <button
            type="button"
            style={{ ...s.submitBtn, opacity: roleAccessSaving ? 0.7 : 1 }}
            disabled={roleAccessSaving}
            onClick={saveRoleAccess}
          >
            {roleAccessSaving ? 'Saving…' : 'Save access matrix'}
          </button>
        </div>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 'min(70vh, 720px)' }} ref={matrixTableRef}>
        <table style={{ ...s.table, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ ...s.th, ...s.stickyHead, ...s.stickyFeature, zIndex: 5 }}>Feature</th>
              <th style={{ ...s.th, ...s.stickyHead, ...s.stickyPerm, textAlign: 'center', zIndex: 5 }}>Permission</th>
              {roleSlugs.map((r) => {
                const cfg = roleCfgMap[r] || { color: t.textMuted, label: r, icon: '👤' };
                const allOn = matrixRows.every((row) => !!roleAccessEdit[row.id]?.[r]);
                const someOn = matrixRows.some((row) => !!roleAccessEdit[row.id]?.[r]);
                const highlighted = matrixHighlightRole === r;
                return (
                  <th
                    key={r}
                    data-role-col={r}
                    onClick={() => setMatrixHighlightRole((prev) => (prev === r ? null : r))}
                    style={{
                      ...s.th,
                      ...s.stickyHead,
                      color: cfg.color,
                      textAlign: 'center',
                      background: highlighted ? `${cfg.color}22` : t.surface2,
                      boxShadow: highlighted ? `inset 0 -3px 0 ${cfg.color}` : undefined,
                      zIndex: 4,
                      cursor: 'pointer',
                    }}
                  >
                    <label
                      style={{
                        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
                        gap: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                      }}
                      title={`${allOn ? 'Clear' : 'Select'} ${cfg.label} for all features`}
                    >
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={(el) => { if (el) el.indeterminate = someOn && !allOn; }}
                        onChange={(e) => setRoleForAllFeatures(r, e.target.checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span>{cfg.icon} {cfg.label}</span>
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {matrixRows.map((row, idx) => {
              const rolesMap = roleAccessEdit[row.id] || row.roles;
              const defaults = row.roles || {};
              const allRolesOn = roleSlugs.every((r) => !!rolesMap[r]);
              const someRolesOn = roleSlugs.some((r) => !!rolesMap[r]);
              const prevGroup = idx > 0 ? matrixRows[idx - 1].group : null;
              const showGroup = row.group && row.group !== prevGroup && !row.parentId;
              const isChild = Boolean(row.parentId);
              const perm = permissionType(row);
              const featureLabel = isChild ? `↳ ${row.feature}` : row.feature;
              return (
                <Fragment key={row.id}>
                  {showGroup && (
                    <tr>
                      <td
                        colSpan={2 + roleSlugs.length}
                        style={{
                          ...s.td,
                          position: 'sticky', left: 0, background: t.surface2,
                          color: t.accent, fontWeight: 700, fontSize: 12,
                          letterSpacing: '0.04em', textTransform: 'uppercase', zIndex: 1,
                        }}
                      >
                        {row.group}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={{
                      ...s.td, ...s.stickyFeature, position: 'sticky', zIndex: 2,
                      fontWeight: isChild ? 400 : 500, color: t.text,
                      paddingLeft: isChild ? 28 : undefined, background: t.surface,
                    }}>
                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={allRolesOn}
                          ref={(el) => { if (el) el.indeterminate = someRolesOn && !allRolesOn; }}
                          onChange={(e) => setAllRolesForFeature(row.id, e.target.checked)}
                        />
                        <span>{featureLabel}</span>
                      </label>
                    </td>
                    <td
                      style={{
                        ...s.td, ...s.stickyPerm, position: 'sticky', zIndex: 2,
                        textAlign: 'center', background: t.surface,
                      }}
                      title={perm.hint}
                    >
                      <span style={{
                        display: 'inline-block', minWidth: 58, padding: '2px 8px',
                        borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
                        color: perm.color, background: `${perm.color}22`, border: `1px solid ${perm.color}66`,
                      }}>
                        {perm.text}
                      </span>
                    </td>
                    {roleSlugs.map((r) => {
                      const current = !!rolesMap[r];
                      const defOn = !!defaults[r];
                      const changed = current !== defOn;
                      const cfg = roleCfgMap[r] || {};
                      const colHighlight = matrixHighlightRole === r;
                      return (
                        <td
                          key={r}
                          data-role-col={r}
                          style={{
                            ...s.td,
                            textAlign: 'center',
                            background: colHighlight
                              ? `${(cfg.color || t.accent)}14`
                              : (changed ? `${t.accent}18` : 'transparent'),
                            verticalAlign: 'middle',
                          }}
                          title={changed ? `Changed from default (${defOn ? 'on' : 'off'})` : `Default: ${defOn ? 'allowed' : 'not allowed'}`}
                        >
                          <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                            <input
                              type="checkbox"
                              checked={current}
                              onChange={() => toggleFeatureRole(row.id, r)}
                              aria-label={`${row.feature} — ${cfg.label || r}`}
                            />
                            <span style={{
                              fontSize: 10, lineHeight: 1.2,
                              color: defOn ? '#10b981' : t.textFaint,
                              fontWeight: defOn ? 700 : 500,
                            }}>
                              {defOn ? '✓' : '—'}
                              <span style={{ color: t.textFaint, fontWeight: 400 }}> def</span>
                            </span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
