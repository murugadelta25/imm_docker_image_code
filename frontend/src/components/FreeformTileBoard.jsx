import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'immFactoryOverview.freeTiles.v3';

/**
 * Default reset layout — matches Factory Overview screenshot:
 * Plan Achievement | Running Rate by Line
 * Achievement by Line | Overall Utilization
 */
export const DEFAULT_LAYOUT = {
  planAchieve: { x: 0.008, y: 0.008, w: 0.486, h: 0.50 },
  runningByLine: { x: 0.506, y: 0.008, w: 0.486, h: 0.50 },
  achieveByLine: { x: 0.008, y: 0.516, w: 0.486, h: 0.476 },
  overallUtil: { x: 0.506, y: 0.516, w: 0.486, h: 0.476 },
};

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_LAYOUT, ...parsed };
  } catch {
    return { ...DEFAULT_LAYOUT };
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
  // Lazy init: pass a function so React calls loadLayout once (not on every render).
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  }, [layout]);

  const resetLayout = useCallback(() => {
    setLayout({ ...DEFAULT_LAYOUT });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_LAYOUT));
    } catch {
      /* ignore */
    }
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
      // Same fallback as render — layout may omit ids until first drag (e.g. new tiles).
      const base = prev[drag.id] || DEFAULT_LAYOUT[drag.id] || {
        x: 0, y: 0, w: 0.45, h: 0.45,
      };
      const cur = { ...base };
      if (drag.mode === 'move') {
        cur.x = Math.max(0, Math.min(1 - cur.w, drag.ox + dx));
        cur.y = Math.max(0, Math.min(1 - cur.h, drag.oy + dy));
      } else {
        cur.w = Math.max(0.28, Math.min(1 - cur.x, drag.ow + dx));
        cur.h = Math.max(0.28, Math.min(1 - cur.y, drag.oh + dy));
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
                padding: 4,
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
