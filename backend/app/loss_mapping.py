"""Map TPM mobile losses → Data Entry / OEE fields and Loss Tracker status."""
from __future__ import annotations

from typing import Optional, Tuple

# oee_field values match OEEEntry / DataEntry form keys
# bucket: breaks | mgmt | downtime | none

LOSS_CODE_MAP = {
    "LOSS-1": ("break_down", "downtime", "breakdown"),
    "LOSS-2": ("setting_time", "downtime", "setting_change"),
    "LOSS-3": ("tool_change", "downtime", "setting_change"),
    "LOSS-5": ("scrap_removal", "downtime", "idle"),
    "LOSS-13": ("dimension_correction", "downtime", "idle"),
}

LOSS9_SUB_MAP = {
    "NO LOAD": ("no_load", "mgmt", "idle"),
    "NO MANPOWER": ("no_manpower_planned", "mgmt", "idle"),
    "POWER CUT": ("power_cut", "mgmt", "offline"),
    "CHIPS REMOVAL": ("scrap_removal", "downtime", "idle"),
    "MEETING": ("management_meeting", "breaks", "idle"),
    "LUNCH": ("lunch_break", "breaks", "idle"),
    "TEA": ("tea_break", "breaks", "idle"),
    "CLITA": ("tpm_cleaning", "breaks", "idle"),
    "TRAINING": ("new_model_trial", "mgmt", "idle"),
    "PERSONAL NEEDS": (None, "none", "idle"),
}


def map_loss_to_oee(
    loss_code: str,
    sub_division: Optional[str] = None,
) -> Tuple[Optional[str], str, str]:
    """
    Returns (oee_field, bucket, machine_status).
    oee_field may be None if not mapped to Data Entry.
    """
    code = (loss_code or "").strip().upper()
    sub = (sub_division or "").strip().upper()
    if code == "LOSS-9":
        return LOSS9_SUB_MAP.get(sub, (None, "none", "idle"))
    return LOSS_CODE_MAP.get(code, (None, "none", "idle"))


DOWNTIME_FIELDS = (
    "setting_time",
    "tool_change",
    "dimension_correction",
    "scrap_removal",
    "break_down",
)
MGMT_FIELDS = (
    "no_load",
    "new_model_trial",
    "power_cut",
    "planned_maintenance",
    "no_manpower_planned",
)
BREAK_FIELDS = (
    "lunch_break",
    "tea_break",
    "tpm_cleaning",
    "other_cleaning",
    "management_meeting",
)

ALL_OEE_LOSS_FIELDS = DOWNTIME_FIELDS + MGMT_FIELDS + BREAK_FIELDS
