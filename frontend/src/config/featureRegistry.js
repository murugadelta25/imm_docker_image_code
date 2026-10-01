/**
 * Feature registry utilities — reads frontend/src/config/feature-registry.json
 *
 * WHEN ADDING A NEW PAGE:
 *  1. Add route in App.jsx
 *  2. Add one entry in feature-registry.json (group item or standalone)
 *  → Navigation, route guards, and /platform/modules update automatically.
 */
import registryJson from './feature-registry.json';
import { NAV_GROUP_ICONS, NAV_ICONS } from '../components/icons/NavIcon';

export const FEATURE_REGISTRY = registryJson;

const ICON_MAP = { ...NAV_ICONS, ...NAV_GROUP_ICONS };

export function resolveNavIcon(key) {
  return ICON_MAP[key] ?? null;
}

/** All toggleable feature item ids (excludes alwaysEnabled standalone and group items). */
export function getAllFeatureItemIds() {
  const ids = [];
  for (const item of FEATURE_REGISTRY.standalone || []) {
    if (!item.alwaysEnabled) ids.push(item.id);
  }
  for (const group of FEATURE_REGISTRY.groups || []) {
    for (const item of group.items || []) {
      if (!item.alwaysEnabled) ids.push(item.id);
    }
  }
  return ids;
}

export function getDefaultFeatureModules() {
  return Object.fromEntries(getAllFeatureItemIds().map(id => [id, true]));
}

/** Path → feature item id (longest match). alwaysEnabled routes return null (never blocked). */
export function pathToFeatureId(pathname) {
  const path = pathname.replace(/\/$/, '') || '/';
  for (const item of FEATURE_REGISTRY.standalone || []) {
    if (item.path === path || path.startsWith(`${item.path}/`)) {
      return item.alwaysEnabled ? null : item.id;
    }
  }
  let best = null;
  let bestLen = -1;
  let bestAlways = false;
  for (const group of FEATURE_REGISTRY.groups || []) {
    for (const item of group.items || []) {
      const p = item.path;
      if (path === p || path.startsWith(`${p}/`)) {
        if (p.length > bestLen) {
          bestLen = p.length;
          best = item.id;
          bestAlways = !!item.alwaysEnabled;
        }
      }
    }
  }
  return bestAlways ? null : best;
}

export function isFeatureEnabled(featureId, modules) {
  if (!featureId) return true;
  const flags = modules || getDefaultFeatureModules();
  return flags[featureId] !== false;
}

export function isRouteEnabled(pathname, modules) {
  return isFeatureEnabled(pathToFeatureId(pathname), modules);
}

/**
 * Build sidebar navigation from registry + role + feature flags.
 * @param {string | undefined} role
 * @param {Record<string, boolean> | undefined} modules
 */
export function buildNavigation(role, modules) {
  const canSee = roles => !roles || roles.includes(role);
  const itemEnabled = id => isFeatureEnabled(id, modules);
  const sections = [];

  for (const item of FEATURE_REGISTRY.standalone || []) {
    if (!canSee(item.roles)) continue;
    if (!item.alwaysEnabled && !itemEnabled(item.id)) continue;
    sections.push({
      group: null,
      items: [{
        path: item.path,
        label: item.label,
        icon: resolveNavIcon(item.navIcon),
        featureId: item.id,
      }],
    });
  }

  for (const group of FEATURE_REGISTRY.groups || []) {
    if (!canSee(group.roles)) continue;
    const items = (group.items || [])
      .filter(item => canSee(item.roles))
      .filter(item => item.alwaysEnabled || itemEnabled(item.id))
      .map(item => ({
        path: item.path,
        label: item.label,
        icon: resolveNavIcon(item.navIcon),
        roles: item.roles,
        featureId: item.id,
      }));
    if (items.length === 0) continue;
    sections.push({
      group: group.label,
      groupId: group.id,
      icon: resolveNavIcon(group.navIcon),
      roles: group.roles,
      items,
    });
  }

  return sections;
}

/** Group helpers for platform admin UI */
export function getRegistryGroups() {
  return FEATURE_REGISTRY.groups || [];
}

export function getRegistryStandalone() {
  return FEATURE_REGISTRY.standalone || [];
}

export function setGroupItemsEnabled(modules, groupId, enabled) {
  const group = (FEATURE_REGISTRY.groups || []).find(g => g.id === groupId);
  if (!group) return modules;
  const next = { ...modules };
  for (const item of group.items || []) {
    next[item.id] = enabled;
  }
  return next;
}

export function isGroupFullyEnabled(modules, groupId) {
  const group = (FEATURE_REGISTRY.groups || []).find(g => g.id === groupId);
  if (!group) return true;
  return (group.items || []).every(item => modules[item.id] !== false);
}

export function isGroupPartiallyEnabled(modules, groupId) {
  const group = (FEATURE_REGISTRY.groups || []).find(g => g.id === groupId);
  if (!group) return false;
  const items = group.items || [];
  const on = items.filter(item => modules[item.id] !== false).length;
  return on > 0 && on < items.length;
}
