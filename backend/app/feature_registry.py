"""Load feature-registry.json — single source of truth for platform toggles."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

REGISTRY_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "src"
    / "config"
    / "feature-registry.json"
)


@lru_cache(maxsize=1)
def load_registry() -> dict[str, Any]:
    data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return data


def registry_groups() -> list[dict[str, Any]]:
    return load_registry().get("groups") or []


def registry_standalone() -> list[dict[str, Any]]:
    return load_registry().get("standalone") or []


def all_feature_item_ids() -> list[str]:
    ids: list[str] = []
    for item in registry_standalone():
        if not item.get("alwaysEnabled"):
            ids.append(item["id"])
    for group in registry_groups():
        for item in group.get("items") or []:
            if not item.get("alwaysEnabled"):
                ids.append(item["id"])
    return ids


def all_group_ids() -> list[str]:
    return [g["id"] for g in registry_groups()]


def path_to_feature_id(path: str) -> str | None:
    normalized = path.rstrip("/") or "/"
    for item in registry_standalone():
        if item.get("path") == normalized:
            return None if item.get("alwaysEnabled") else item["id"]
    for group in registry_groups():
        for item in group.get("items") or []:
            item_path = item.get("path", "")
            if normalized == item_path or normalized.startswith(item_path + "/"):
                return item["id"]
    return None


def registry_payload() -> dict[str, Any]:
    reg = load_registry()
    return {
        "version": reg.get("version", 1),
        "standalone": reg.get("standalone") or [],
        "groups": reg.get("groups") or [],
    }
