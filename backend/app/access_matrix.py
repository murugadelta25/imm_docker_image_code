"""Default feature × role access matrix (pages from feature-registry.json + action rows)."""
from __future__ import annotations

from typing import Any

from .feature_registry import registry_groups, registry_standalone
from .role_seeds import TOGGLEABLE_ROLES

# Page-level View is the registry row. These are Edit / Action ticks nested under a page.
_PLAN = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": True, "operator": False, "maintenance": False, "quality": False}
_OP_RAISE = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": True, "operator": True, "maintenance": False, "quality": False}
_MAINT = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": False, "operator": False, "maintenance": True, "quality": False}
_ENTRY = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": True, "operator": True, "maintenance": False, "quality": False}
_QC_INSPECT = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": True, "operator": False, "maintenance": False, "quality": True}
_QC_APPROVE = {"superadmin": True, "admin": True, "site_admin": True, "supervisor": True, "operator": False, "maintenance": False, "quality": False}

CAPABILITY_ROWS: list[dict[str, Any]] = [
    {
        "id": "capability.edit_work_orders",
        "label": "Create / Edit Work Orders",
        "group": "Production",
        "kind": "edit",
        "parent_id": "production.work_orders",
        "roles": dict(_PLAN),
    },
    {
        "id": "capability.edit_planning",
        "label": "Create / Edit Plans",
        "group": "Production",
        "kind": "edit",
        "parent_id": "production.planning",
        "roles": dict(_PLAN),
    },
    {
        "id": "capability.edit_data_entry",
        "label": "Submit Data Entry",
        "group": "Production",
        "kind": "edit",
        "parent_id": "production.data_entry",
        "roles": dict(_ENTRY),
    },
    {
        "id": "capability.raise_model_change",
        "label": "Raise Model Change",
        "group": "Production",
        "kind": "action",
        "parent_id": "production.model_change",
        "roles": dict(_OP_RAISE),
    },
    {
        "id": "capability.approve_model_change",
        "label": "Approve Model Change",
        "group": "Production",
        "kind": "action",
        "parent_id": "production.model_change",
        "roles": dict(_PLAN),
    },
    {
        "id": "capability.raise_breakdown",
        "label": "Raise Breakdown Ticket",
        "group": "Maintenance",
        "kind": "action",
        "parent_id": "maintenance.breakdown",
        "roles": dict(_OP_RAISE),
    },
    {
        "id": "capability.ack_breakdown",
        "label": "Acknowledge Breakdown",
        "group": "Maintenance",
        "kind": "action",
        "parent_id": "maintenance.dashboard",
        "roles": dict(_MAINT),
    },
    {
        "id": "capability.resolve_breakdown",
        "label": "Resolve / Troubleshoot Breakdown",
        "group": "Maintenance",
        "kind": "action",
        "parent_id": "maintenance.dashboard",
        "roles": dict(_MAINT),
    },
    {
        "id": "capability.qc_inspect",
        "label": "QC Inspect / Submit",
        "group": "QC",
        "kind": "edit",
        "parent_id": "qc.approvals",
        "roles": dict(_QC_INSPECT),
    },
    {
        "id": "capability.qc_approve",
        "label": "QC Incharge Approve",
        "group": "QC",
        "kind": "action",
        "parent_id": "qc.approvals",
        "roles": dict(_QC_APPROVE),
    },
    {
        "id": "capability.edit_tools",
        "label": "Create / Edit Tools",
        "group": "Settings",
        "kind": "edit",
        "parent_id": "settings.tools",
        "roles": dict(_PLAN),
    },
]


def roles_map_from_allowed(
    allowed: set[str] | list[str] | None,
    role_slugs: list[str] | None = None,
) -> dict[str, bool]:
    """Build a full role→bool map. Site Admin follows Admin unless listed explicitly."""
    slugs = list(role_slugs or TOGGLEABLE_ROLES)
    allowed_set = set(allowed or [])
    out = {role: (role in allowed_set) for role in slugs}
    if "admin" in allowed_set and "site_admin" in slugs and "site_admin" not in allowed_set:
        out["site_admin"] = True
    return out


def _complete_roles(
    partial: dict[str, bool] | None,
    role_slugs: list[str] | None = None,
) -> dict[str, bool]:
    slugs = list(role_slugs or TOGGLEABLE_ROLES)
    src = partial or {}
    out = {role: bool(src.get(role, False)) for role in slugs}
    if "admin" in slugs and src.get("admin") and "site_admin" in slugs and "site_admin" not in src:
        out["site_admin"] = True
    return out


def _page_rows_from_registry(role_slugs: list[str] | None = None) -> list[dict[str, Any]]:
    slugs = list(role_slugs or TOGGLEABLE_ROLES)
    rows: list[dict[str, Any]] = []
    for item in registry_standalone():
        if item.get("alwaysEnabled"):
            continue
        allowed = item.get("roles")
        rows.append({
            "id": item["id"],
            "label": item.get("label") or item["id"],
            "registry_id": item["id"],
            "group": "Pages",
            "kind": "page",
            "roles": roles_map_from_allowed(allowed if allowed is not None else slugs, slugs),
        })
    for group in registry_groups():
        group_label = group.get("label") or group.get("id") or "Pages"
        group_roles = group.get("roles") or []
        for item in group.get("items") or []:
            if item.get("alwaysEnabled"):
                continue
            allowed = item.get("roles")
            if allowed is None:
                allowed = group_roles
            rows.append({
                "id": item["id"],
                "label": item.get("label") or item["id"],
                "registry_id": item["id"],
                "group": group_label,
                "kind": "page",
                "roles": roles_map_from_allowed(allowed, slugs),
            })
    return rows


def access_matrix_rows(role_slugs: list[str] | None = None) -> list[dict[str, Any]]:
    pages = _page_rows_from_registry(role_slugs)
    cap_rows: list[dict[str, Any]] = []
    for cap in CAPABILITY_ROWS:
        cap_rows.append({
            "id": cap["id"],
            "label": cap["label"],
            "registry_id": None,
            "group": cap.get("group") or "Actions",
            "kind": cap.get("kind") or "action",
            "parent_id": cap.get("parent_id"),
            "roles": _complete_roles(cap.get("roles"), role_slugs),
        })
    by_parent: dict[str, list[dict[str, Any]]] = {}
    rest: list[dict[str, Any]] = []
    for cap in cap_rows:
        parent = cap.get("parent_id")
        if parent:
            by_parent.setdefault(parent, []).append(cap)
        else:
            rest.append(cap)
    rows: list[dict[str, Any]] = []
    for page in pages:
        rows.append(page)
        rows.extend(by_parent.get(page["id"]) or [])
    rows.extend(rest)
    return rows


def access_matrix_role_defaults(role_slugs: list[str] | None = None) -> dict[str, dict[str, bool]]:
    out: dict[str, dict[str, bool]] = {}
    for row in access_matrix_rows(role_slugs):
        roles = _complete_roles(row.get("roles"), role_slugs)
        out[row["id"]] = dict(roles)
        rid = row.get("registry_id")
        if rid and rid != row["id"]:
            out[rid] = dict(roles)
    return out


def access_matrix_payload(role_slugs: list[str] | None = None) -> list[dict[str, Any]]:
    return [
        {
            "id": row["id"],
            "label": row["label"],
            "registryId": row.get("registry_id"),
            "group": row.get("group") or "Pages",
            "kind": row.get("kind") or "page",
            "parentId": row.get("parent_id"),
            "defaultRoles": _complete_roles(row.get("roles"), role_slugs),
        }
        for row in access_matrix_rows(role_slugs)
    ]
