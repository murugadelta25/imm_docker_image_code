"""Customer feature toggles — per menu item from feature-registry.json."""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from .feature_registry import (
    all_feature_item_ids,
    registry_groups,
    registry_payload,
    registry_standalone,
)
from .access_matrix import (
    access_matrix_payload,
    access_matrix_role_defaults,
)
from .role_seeds import TOGGLEABLE_ROLES, list_roles_payload
from .models import SiteConfig

__all__ = [
    "default_feature_modules",
    "get_feature_modules",
    "set_feature_modules",
    "get_feature_role_access",
    "set_feature_role_access",
    "capability_configured_in_role_access",
    "feature_modules_payload",
]

# Feature ids that once shipped without a `roles` list in feature-registry.json.
_ROLE_ACCESS_REPAIR_IDS = frozenset({"qc.work_instructions"})


def default_feature_modules() -> dict[str, bool]:
    return {item_id: True for item_id in all_feature_item_ids()}


def _normalize(modules: dict[str, Any] | None) -> dict[str, bool]:
    """Merge stored flags with registry; support legacy group-level keys."""
    out = default_feature_modules()
    if not modules:
        return out

    item_ids = set(all_feature_item_ids())

    for group in registry_groups():
        gid = group["id"]
        if gid in modules and modules[gid] is False:
            for item in group.get("items") or []:
                out[item["id"]] = False

    for key, value in modules.items():
        if key in item_ids:
            out[key] = bool(value)

    for group in registry_groups():
        gid = group["id"]
        if gid in modules and modules[gid] is True:
            for item in group.get("items") or []:
                if item["id"] not in modules:
                    out[item["id"]] = True

    return out


def _iter_registry_items() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in registry_standalone():
        if item.get("alwaysEnabled"):
            continue
        items.append(item)
    for group in registry_groups():
        group_roles = group.get("roles")
        for item in group.get("items") or []:
            if item.get("alwaysEnabled"):
                continue
            merged = dict(item)
            if merged.get("roles") is None and group_roles is not None:
                merged["roles"] = list(group_roles)
            items.append(merged)
    return items


def _toggleable_roles(_db: Session | None = None) -> list[str]:
    return list(TOGGLEABLE_ROLES)


def _default_role_access_for_item(item: dict[str, Any], role_slugs: list[str]) -> dict[str, bool]:
    from .access_matrix import roles_map_from_allowed
    allowed = item.get("roles")
    if allowed is None:
        allowed = list(role_slugs)
    return roles_map_from_allowed(allowed, role_slugs)


def default_feature_role_access(db: Session) -> dict[str, dict[str, bool]]:
    role_slugs = _toggleable_roles(db)
    out: dict[str, dict[str, bool]] = {}
    for item in _iter_registry_items():
        out[item["id"]] = _default_role_access_for_item(item, role_slugs)
    for feature_id, roles in access_matrix_role_defaults(role_slugs).items():
        out[feature_id] = dict(roles)
    return out


def _normalize_role_access(stored: dict[str, Any] | None, db: Session) -> dict[str, dict[str, bool]]:
    role_slugs = _toggleable_roles(db)
    out = default_feature_role_access(db)
    if not isinstance(stored, dict):
        return out
    for feature_id, roles_map in stored.items():
        if feature_id not in out or not isinstance(roles_map, dict):
            continue
        if feature_id in _ROLE_ACCESS_REPAIR_IDS and not any(
            bool(v) for v in roles_map.values()
        ):
            continue
        merged = {role: bool(out[feature_id].get(role, False)) for role in role_slugs}
        for role, enabled in roles_map.items():
            if role in role_slugs:
                merged[role] = bool(enabled)
        if "site_admin" in role_slugs and "site_admin" not in roles_map and roles_map.get("admin"):
            merged["site_admin"] = bool(roles_map["admin"])
        for role, enabled in roles_map.items():
            if role not in role_slugs:
                merged[role] = bool(enabled)
        out[feature_id] = merged
    return out


def _load_site_json(db: Session) -> dict:
    row = db.query(SiteConfig).first()
    if not row:
        return {}
    try:
        return json.loads(row.config_json)
    except (json.JSONDecodeError, TypeError):
        return {}


def get_feature_modules(db: Session) -> dict[str, bool]:
    stored = _load_site_json(db).get("featureModules")
    return _normalize(stored)


def set_feature_modules(db: Session, modules: dict[str, bool]) -> dict[str, bool]:
    item_ids = set(all_feature_item_ids())
    filtered = {k: bool(v) for k, v in modules.items() if k in item_ids}
    normalized = _normalize(filtered)
    row = db.query(SiteConfig).first()
    if row:
        cfg = _load_site_json(db)
        cfg["featureModules"] = normalized
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps({"featureModules": normalized})))
    db.commit()
    return normalized


def get_feature_role_access(db: Session) -> dict[str, dict[str, bool]]:
    stored = _load_site_json(db).get("featureRoleAccess")
    return _normalize_role_access(stored, db)


def capability_configured_in_role_access(db: Session, capability_id: str) -> bool:
    """True only when this capability id was persisted in SiteConfig.featureRoleAccess."""
    stored = _load_site_json(db).get("featureRoleAccess")
    if not isinstance(stored, dict):
        return False
    entry = stored.get(capability_id)
    return isinstance(entry, dict)


def set_feature_role_access(
    db: Session,
    role_access: dict[str, dict[str, bool]],
) -> dict[str, dict[str, bool]]:
    """Update role access for registry + access-matrix feature ids.

    Merges into existing SiteConfig so featureModules and other keys are preserved.
    """
    role_slugs = set(_toggleable_roles(db))
    defaults = default_feature_role_access(db)
    allowed_ids = set(defaults.keys())
    current = get_feature_role_access(db)
    next_map = dict(current)

    for feature_id, roles_map in (role_access or {}).items():
        if feature_id not in allowed_ids:
            continue
        if not isinstance(roles_map, dict):
            continue
        merged = dict(next_map.get(feature_id) or defaults[feature_id])
        for role, enabled in roles_map.items():
            if role in role_slugs or role in merged:
                merged[role] = bool(enabled)
        next_map[feature_id] = merged
        for row in access_matrix_payload(list(role_slugs)):
            if row["id"] == feature_id and row.get("registryId") and row["registryId"] != feature_id:
                next_map[row["registryId"]] = dict(merged)
            if row.get("registryId") == feature_id and row["id"] != feature_id:
                next_map[row["id"]] = dict(merged)

    row = db.query(SiteConfig).first()
    if row:
        cfg = _load_site_json(db)
        cfg["featureRoleAccess"] = next_map
        row.config_json = json.dumps(cfg)
    else:
        db.add(SiteConfig(config_json=json.dumps({"featureRoleAccess": next_map})))
    db.commit()
    return get_feature_role_access(db)


def feature_modules_payload(db: Session) -> dict:
    role_slugs = _toggleable_roles(db)
    return {
        "registry": registry_payload(),
        "modules": get_feature_modules(db),
        "roleAccess": get_feature_role_access(db),
        "accessMatrix": access_matrix_payload(role_slugs),
        "toggleableRoles": role_slugs,
        "roles": list_roles_payload(),
    }
