/**
 * Feature × role access matrix (User Management).
 * Page rows are generated from feature-registry.json so every route is listed.
 * Action rows are extra capabilities (not sidebar pages).
 */
import registryJson from './feature-registry.json';

export const ACCESS_MATRIX_ROLES = [
  'superadmin',
  'admin',
  'site_admin',
  'supervisor',
  'operator',
  'maintenance',
  'quality',
];

/** Keep built-in roles even if the API only returns a newly created custom role. */
export function mergeAccessMatrixRoles(apiSlugs) {
  const seen = new Set();
  const out = [];
  for (const slug of [...ACCESS_MATRIX_ROLES, ...(apiSlugs || [])]) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out.length ? out : [...ACCESS_MATRIX_ROLES];
}

function rolesMapFromAllowed(allowed, roleSlugs = ACCESS_MATRIX_ROLES) {
  const set = new Set(allowed || []);
  const out = {};
  for (const role of roleSlugs) {
    out[role] = set.has(role);
  }
  if (set.has('admin') && roleSlugs.includes('site_admin') && !set.has('site_admin')) out.site_admin = true;
  return out;
}

const ADMIN_EDIT = ['superadmin', 'admin', 'site_admin', 'supervisor'];
const OP_RAISE = ['superadmin', 'admin', 'site_admin', 'supervisor', 'operator'];
const MAINT_ACT = ['superadmin', 'admin', 'site_admin', 'maintenance'];
const ENTRY_EDIT = ['superadmin', 'admin', 'site_admin', 'supervisor', 'operator'];
const QC_INSPECT = ['superadmin', 'admin', 'site_admin', 'supervisor', 'quality'];
const QC_APPROVE = ['superadmin', 'admin', 'site_admin', 'supervisor'];

const CAPABILITY_ROWS = [
  {
    id: 'capability.edit_work_orders',
    feature: 'Create / Edit Work Orders',
    parentId: 'production.work_orders',
    group: 'Production',
    kind: 'edit',
    roles: rolesMapFromAllowed(ADMIN_EDIT),
  },
  {
    id: 'capability.edit_planning',
    feature: 'Create / Edit Plans',
    parentId: 'production.planning',
    group: 'Production',
    kind: 'edit',
    roles: rolesMapFromAllowed(ADMIN_EDIT),
  },
  {
    id: 'capability.edit_data_entry',
    feature: 'Submit Data Entry',
    parentId: 'production.data_entry',
    group: 'Production',
    kind: 'edit',
    roles: rolesMapFromAllowed(ENTRY_EDIT),
  },
  {
    id: 'capability.raise_model_change',
    feature: 'Raise Model Change',
    parentId: 'production.model_change',
    group: 'Production',
    kind: 'action',
    roles: rolesMapFromAllowed(OP_RAISE),
  },
  {
    id: 'capability.approve_model_change',
    feature: 'Approve Model Change',
    parentId: 'production.model_change',
    group: 'Production',
    kind: 'action',
    roles: rolesMapFromAllowed(ADMIN_EDIT),
  },
  {
    id: 'capability.raise_breakdown',
    feature: 'Raise Breakdown Ticket',
    parentId: 'maintenance.breakdown',
    group: 'Maintenance',
    kind: 'action',
    roles: rolesMapFromAllowed(OP_RAISE),
  },
  {
    id: 'capability.ack_breakdown',
    feature: 'Acknowledge Breakdown',
    parentId: 'maintenance.dashboard',
    group: 'Maintenance',
    kind: 'action',
    roles: rolesMapFromAllowed(MAINT_ACT),
  },
  {
    id: 'capability.resolve_breakdown',
    feature: 'Resolve / Troubleshoot Breakdown',
    parentId: 'maintenance.dashboard',
    group: 'Maintenance',
    kind: 'action',
    roles: rolesMapFromAllowed(MAINT_ACT),
  },
  {
    id: 'capability.qc_inspect',
    feature: 'QC Inspect / Submit',
    parentId: 'qc.approvals',
    group: 'QC',
    kind: 'edit',
    roles: rolesMapFromAllowed(QC_INSPECT),
  },
  {
    id: 'capability.qc_approve',
    feature: 'QC Incharge Approve',
    parentId: 'qc.approvals',
    group: 'QC',
    kind: 'action',
    roles: rolesMapFromAllowed(QC_APPROVE),
  },
  {
    id: 'capability.edit_tools',
    feature: 'Create / Edit Tools',
    parentId: 'settings.tools',
    group: 'Settings',
    kind: 'edit',
    roles: rolesMapFromAllowed(ADMIN_EDIT),
  },
];

function nestCapabilityRows(pageRows, capRows, roleSlugs = ACCESS_MATRIX_ROLES) {
  const caps = capRows.map((r) => ({
    ...r,
    roles: rolesMapFromAllowed(
      Object.entries(r.roles || {}).filter(([, v]) => v).map(([k]) => k),
      roleSlugs,
    ),
  }));
  const byParent = new Map();
  const rest = [];
  for (const cap of caps) {
    if (cap.parentId) {
      if (!byParent.has(cap.parentId)) byParent.set(cap.parentId, []);
      byParent.get(cap.parentId).push(cap);
    } else {
      rest.push(cap);
    }
  }
  const out = [];
  for (const page of pageRows) {
    out.push(page);
    out.push(...(byParent.get(page.id) || []));
  }
  out.push(...rest);
  return out;
}

export function normalizeAccessMatrixFromApi(apiRows, roleSlugs = ACCESS_MATRIX_ROLES) {
  if (!Array.isArray(apiRows) || apiRows.length === 0) {
    return nestCapabilityRows(pageRowsFromRegistry(roleSlugs), CAPABILITY_ROWS, roleSlugs);
  }
  return apiRows.map((row) => ({
    id: row.id,
    feature: row.label || row.feature,
    registryId: row.registryId,
    group: row.group || (row.kind === 'action' || row.kind === 'edit' ? 'Actions' : 'Pages'),
    kind: row.kind || (String(row.id || '').startsWith('capability.') ? 'action' : 'page'),
    parentId: row.parentId || null,
    roles: {
      ...rolesMapFromAllowed([], roleSlugs),
      ...(row.defaultRoles || row.roles || {}),
    },
  }));
}

function pageRowsFromRegistry(roleSlugs = ACCESS_MATRIX_ROLES) {
  const rows = [];
  for (const item of registryJson.standalone || []) {
    rows.push({
      id: item.id,
      feature: item.label || item.id,
      registryId: item.id,
      group: 'Pages',
      kind: 'page',
      roles: rolesMapFromAllowed(item.roles || roleSlugs, roleSlugs),
    });
  }
  for (const group of registryJson.groups || []) {
    const groupLabel = group.label || group.id || 'Pages';
    for (const item of group.items || []) {
      const allowed = item.roles || group.roles || [];
      rows.push({
        id: item.id,
        feature: item.label || item.id,
        registryId: item.id,
        group: groupLabel,
        kind: 'page',
        roles: rolesMapFromAllowed(allowed, roleSlugs),
      });
    }
  }
  return rows;
}

export function getAccessMatrixRoleDefaults(roleSlugs = ACCESS_MATRIX_ROLES) {
  const rows = nestCapabilityRows(pageRowsFromRegistry(roleSlugs), CAPABILITY_ROWS, roleSlugs);
  const out = {};
  for (const row of rows) {
    out[row.id] = { ...row.roles };
    if (row.registryId && row.registryId !== row.id) {
      out[row.registryId] = { ...row.roles };
    }
  }
  return out;
}

/** Treat Super Admin and Site Admin as Admin wherever Admin is allowed. */
export function hasRole(userRole, ...allowed) {
  if (!userRole) return false;
  const set = new Set(allowed);
  if (set.has('admin')) {
    set.add('superadmin');
    set.add('site_admin');
  }
  return set.has(userRole);
}

/** @type {{ id: string, feature: string, registryId?: string, group?: string, kind?: string, parentId?: string, roles: Record<string, boolean> }[]} */
export const ACCESS_MATRIX = nestCapabilityRows(pageRowsFromRegistry(), CAPABILITY_ROWS);
