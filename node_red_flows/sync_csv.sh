#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# sync_csv.sh
# Copies Node-RED shot counter CSV files from the NFS source directory to the
# local destination directory every time it runs (called by cron every hour).
#
# Source : /mnt/nfs/nodered/data/eap_shots/   (Node-RED writes here)
# Dest   : /home/sie/node-red_csv_writer/      (local accessible copy)
#
# Behaviour:
#  - Copies ALL ShiftA_*.csv and ShiftB_*.csv files
#  - Overwrites destination file with latest source content (rsync --checksum)
#  - If source NFS is not mounted / unreachable, logs warning and exits cleanly
#  - Logs each run to /home/sie/node-red_csv_writer/sync.log (keeps last 500 lines)
# ─────────────────────────────────────────────────────────────────────────────

SRC="/mnt/nfs/nodered/data/eap_shots"
DST="/home/sie/node-red_csv_writer"
LOG="$DST/sync.log"
TS=$(date '+%Y-%m-%d %H:%M:%S')

# ── ensure destination exists ─────────────────────────────────────────────────
mkdir -p "$DST"

# ── check source is accessible ────────────────────────────────────────────────
if [ ! -d "$SRC" ]; then
  echo "[$TS] WARN: source $SRC not accessible — skipping sync" >> "$LOG"
  exit 0
fi

# ── count files to copy ───────────────────────────────────────────────────────
FILE_COUNT=$(find "$SRC" -maxdepth 1 -name 'Shift*.csv' | wc -l)

if [ "$FILE_COUNT" -eq 0 ]; then
  echo "[$TS] INFO: no CSV files found in $SRC" >> "$LOG"
  exit 0
fi

# ── sync: copy every Shift*.csv, overwrite if source is newer or different ────
COPIED=0
ERRORS=0

for SRC_FILE in "$SRC"/Shift*.csv; do
  FNAME=$(basename "$SRC_FILE")
  DST_FILE="$DST/$FNAME"

  # Use cp with -f to force overwrite even if destination is open
  if cp -f "$SRC_FILE" "$DST_FILE" 2>/dev/null; then
    chmod 664 "$DST_FILE" 2>/dev/null
    COPIED=$((COPIED + 1))
  else
    echo "[$TS] ERROR: failed to copy $FNAME" >> "$LOG"
    ERRORS=$((ERRORS + 1))
  fi
done

echo "[$TS] OK: copied $COPIED file(s) from $SRC to $DST (errors=$ERRORS)" >> "$LOG"

# ── trim log to last 500 lines to prevent unbounded growth ────────────────────
if [ -f "$LOG" ]; then
  LINES=$(wc -l < "$LOG")
  if [ "$LINES" -gt 500 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
fi

exit 0
