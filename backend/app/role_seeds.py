"""Built-in role seed data (no DB / matrix imports)."""

BUILTIN_ROLE_SEEDS = [
    {
        "slug": "superadmin",
        "label": "Super Admin",
        "description": "Full access + factory setup, data backup & archive",
        "color": "#dc2626",
        "icon": "🛡",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 10,
    },
    {
        "slug": "admin",
        "label": "Admin",
        "description": "Full access to all features except factory setup & backup",
        "color": "#ef4444",
        "icon": "⚙",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 20,
    },
    {
        "slug": "site_admin",
        "label": "Site Admin",
        "description": "Plant-level access — grant pages in the Feature Access Matrix",
        "color": "#f97316",
        "icon": "🏭",
        "is_system": 1,
        "inherits_slug": "admin",
        "sort_order": 25,
    },
    {
        "slug": "supervisor",
        "label": "Supervisor",
        "description": "Planning, data entry, QC incharge approval",
        "color": "#f59e0b",
        "icon": "📋",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 30,
    },
    {
        "slug": "operator",
        "label": "Operator",
        "description": "Shop-floor web/tablet login — roster in Operator Management",
        "color": "#0ea5e9",
        "icon": "🔧",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 40,
    },
    {
        "slug": "maintenance",
        "label": "Maintenance",
        "description": "Acknowledge and resolve breakdown tickets",
        "color": "#10b981",
        "icon": "🛠",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 50,
    },
    {
        "slug": "quality",
        "label": "Quality",
        "description": "QC inspection sheet — inspector approval",
        "color": "#8b5cf6",
        "icon": "✓",
        "is_system": 1,
        "inherits_slug": None,
        "sort_order": 60,
    },
]

TOGGLEABLE_ROLES = [s["slug"] for s in BUILTIN_ROLE_SEEDS]


def list_roles_payload() -> list[dict]:
    """Static role list for Feature Flags / User Management (no AppRole table)."""
    return [
        {
            "slug": s["slug"],
            "label": s["label"],
            "description": s.get("description") or "",
            "color": s.get("color") or "#64748b",
            "icon": s.get("icon") or "👤",
            "isSystem": bool(s.get("is_system")),
            "inheritsSlug": s.get("inherits_slug"),
        }
        for s in BUILTIN_ROLE_SEEDS
    ]
