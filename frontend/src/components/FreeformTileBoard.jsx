import { useCallback, useEffect, useRef, useState } from 'react';

/** Bump when default grid changes so browsers drop broken saved layouts. */
const LAYOUT_VERSION = 6;
const STORAGE_KEY = `immFactoryOverview.freeTiles.v${LAYOUT_VERSION}`;

/**
 * Default 3×2 grid — gaps between cells, no overlap:
 * Row 1: Plan Achievement (Today) | Hourly Running Rate | Plant Energy Meter
 * Row 2: Plan Achievement (shift) | Achievement by Zone | Overall Utilization
 */
export const DEFAULT_LAYOUT = {
  planAchieveToday: { x: 0.00, y: 0.00, w: 0.325, h: 0.485 },
  runningByLine: { x: 0.3375, y: 0.00, w: 0.325, h: 0.485 },
  energyMeter: { x: 0.675, y: 0.00, w: 0.325, h: 0.485 },
  planAchieve: { x: 0.00, y: 0.515, w: 0.325, h: 0.485 },
  achieveByLine: { x: 0.3375, y: 0.515, w: 0.325, h: 0.485 },
  overallUtil: { x: 0.675, y: 0.515, w: 0.325, h: 0.485 },
};

const TILE_IDS = Object.keys(DEFAULT_LAYOUT);

function rectsOverlap(a, b, gap = 0.004) {
  return !(
    a.x + a.w + gap <= b.x
    || b.x + b.w + gap <= a.x
    || a.y + a.h + gap <= b.y
    || b.y + b.h + gap <= a.y
  );
}

function layoutHasOverlap(layout) {
  const rects = TILE_IDS.map((id) => layout[id]).filter(Boolean);
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i], rects[j])) return true;
    }
  }
  return false;
}

function clearLegacyLayouts() {
  try {
    for (let v = 1; v < LAYOUT_VERSION; v += 1) {
      localStorage.removeItem(`immFactoryOverview.freeTiles.v${v}`);
    }
  } catch {
    /* ignore */
  }
}

function loadLayout() {
  clearLegacyLayouts();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed._version !== LAYOUT_VERSION) {
      return { ...DEFAULT_LAYOUT };
    }
    const merged = { ...DEFAULT_LAYOUT };
    TILE_IDS.forEach((id) => {
      const p = parsed[id];
      if (
        p
        && typeof p.x === 'number'
        && typeof p.y === 'number'
        && typeof p.w === 'number'
        && typeof p.h === 'number'
      ) {
        merged[id] = {
          x: Math.max(0, Math.min(1, p.x)),
          y: Math.max(0, Math.min(1, p.y)),
          w: Math.max(0.2, Math.min(1, p.w)),
          h: Math.max(0.2, Math.min(1, p.h)),
        };
      }
    });
    if (layoutHasOverlap(merged)) return { ...DEFAULT_LAYOUT };
    return merged;
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

function persistLayout(layout) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...layout, _version: LAYOUT_VERSION }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Free-size dashboard board: drag tiles to reposition, drag corner to resize.
 * Positions are fractions of the board (0–1) so layout scales with screen.
 * When fillHeight is true, board fills its flex parent (viewport-fit pages).
 */
export default function FreeformTileBoard({
  tiles = [],
  theme,
  minBoardHeight = 280,
  fillHeight = false,
  resetRef,
}) {
  const boardRef = useRef(null);
  const [layout, setLayout] = useState(() => loadLayout());
  const [drag, setDrag] = useState(null);
  const [boardSize, setBoardSize] = useState({ w: 800, h: minBoardHeight });

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const floor = fillHeight ? 160 : minBoardHeight;
      setBoardSize({
        w: Math.max(280, width),
        h: Math.max(floor, height),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [minBoardHeight, fillHeight]);

  useEffect(() => {
    persistLayout(layout);
  }, [layout]);

  const resetLayout = useCallback(() => {
    const next = { ...DEFAULT_LAYOUT };
    setLayout(next);
    persistLayout(next);
  }, []);

  // One-shot: if a previous broken layout slipped through, snap to default on mount.
  useEffect(() => {
    if (layoutHasOverlap(layout)) {
      resetLayout();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  useEffect(() => {
    if (resetRef) resetRef.current = resetLayout;
  }, [resetRef, resetLayout]);

  const onPointerMove = useCallback((e) => {
    if (!drag || !boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    setLayout((prev) => {
      const base = prev[drag.id] || DEFAULT_LAYOUT[drag.id] || {
        x: 0, y: 0, w: 0.45, h: 0.45,
      };
      const cur = { ...base };
      if (drag.mode === 'move') {
        cur.x = Math.max(0, Math.min(1 - cur.w, drag.ox + dx));
        cur.y = Math.max(0, Math.min(1 - cur.h, drag.oy + dy));
      } else {
        cur.w = Math.max(0.22, Math.min(1 - cur.x, drag.ow + dx));
        cur.h = Math.max(0.22, Math.min(1 - cur.y, drag.oh + dy));
      }
      return { ...prev, [drag.id]: cur };
    });
  }, [drag]);

  const endDrag = useCallback(() => setDrag(null), []);

  useEffect(() => {
    if (!drag) return undefined;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [drag, onPointerMove, endDrag]);

  const dim = theme?.textDim || '#94a3b8';

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        flex: fillHeight ? 1 : undefined,
        minHeight: fillHeight ? 0 : minBoardHeight,
        height: fillHeight ? '100%' : minBoardHeight,
        alignSelf: 'stretch',
      }}
    >
      <div
        ref={boardRef}
        style={{
          position: fillHeight ? 'absolute' : 'relative',
          inset: fillHeight ? 0 : undefined,
          width: '100%',
          height: fillHeight ? '100%' : minBoardHeight,
          minHeight: fillHeight ? 0 : minBoardHeight,
        }}
      >
        {tiles.map((tile) => {
          const pos = layout[tile.id] || DEFAULT_LAYOUT[tile.id] || {
            x: 0, y: 0, w: 0.45, h: 0.45,
          };
          const left = pos.x * boardSize.w;
          const top = pos.y * boardSize.h;
          const width = pos.w * boardSize.w;
          const height = pos.h * boardSize.h;
          const active = drag?.id === tile.id;

          return (
            <div
              key={tile.id}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                zIndex: active ? 20 : 1,
                boxSizing: 'border-box',
                padding: 6,
              }}
            >
              <div
                style={{
                  position: 'relative',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 12,
                  overflow: 'hidden',
                  boxShadow: active ? `0 0 0 2px ${theme?.accent || '#38bdf8'}` : undefined,
                  ...tile.style,
                }}
              >
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    setDrag({
                      id: tile.id,
                      mode: 'move',
                      startX: e.clientX,
                      startY: e.clientY,
                      ox: pos.x,
                      oy: pos.y,
                      ow: pos.w,
                      oh: pos.h,
                    });
                  }}
                  style={{
                    cursor: 'grab',
                    userSelect: 'none',
                    touchAction: 'none',
                    flexShrink: 0,
                  }}
                  title="Drag to move"
                >
                  {tile.header}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                  {tile.body}
                </div>
                <div
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    setDrag({
                      id: tile.id,
                      mode: 'resize',
                      startX: e.clientX,
                      startY: e.clientY,
                      ox: pos.x,
                      oy: pos.y,
                      ow: pos.w,
                      oh: pos.h,
                    });
                  }}
                  style={{
                    position: 'absolute',
                    right: 8,
                    bottom: 8,
                    width: 14,
                    height: 14,
                    cursor: 'nwse-resize',
                    borderRight: `2px solid ${dim}`,
                    borderBottom: `2px solid ${dim}`,
                    opacity: 0.7,
                    touchAction: 'none',
                  }}
                  title="Drag to resize"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
