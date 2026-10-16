import { useState, useEffect, useRef, useMemo, useId } from 'react';
import { useConfig, getCurrentShift } from '../context/ConfigContext';
import { useTheme } from '../context/ThemeContext';
import NotificationBell from './NotificationBell';

const AUTO_REFRESH_SEC = 60;

/**
 * PageHeader
 * Props:
 *   title      – page title string (e.g. "Production Planning")
 *   onRefresh  – async/sync function to call on manual or auto refresh
 *                Pass undefined while a modal/sheet is open to halt the timer
 *   extra      – optional JSX rendered between title and clock (e.g. action buttons)
 */
export default function PageHeader({ title, onRefresh, extra }) {
  const [now, setNow] = useState(new Date());
  const { config, ready: configReady } = useConfig();
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SEC);
  const [flipDeg, setFlipDeg] = useState(0);
  const [orient, setOrient] = useState(0); // 0 upright, 1 after odd flips — drives sand chambers
  const [flipping, setFlipping] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const countRef = useRef(AUTO_REFRESH_SEC);
  const onRefreshRef = useRef(onRefresh);
  const flippingRef = useRef(false);
  const { theme: t } = useTheme();
  const uid = useId().replace(/:/g, '');

  onRefreshRef.current = onRefresh;
  const timerPaused = !onRefresh;

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Recompute from latest config each second so shift badge tracks real windows after login
  const currentShift = useMemo(
    () => (configReady ? getCurrentShift(config) : null),
    [config, configReady, now],
  );

  const finishFlip = () => {
    if (!flippingRef.current) return;
    flippingRef.current = false;
    setFlipping(false);
    setOrient((o) => (o === 0 ? 1 : 0));
    countRef.current = AUTO_REFRESH_SEC;
    setCountdown(AUTO_REFRESH_SEC);
  };

  const triggerRefresh = async () => {
    const fn = onRefreshRef.current;
    if (!fn || flippingRef.current) return;
    flippingRef.current = true;
    setFlipping(true);
    setFlipDeg((d) => d + 180);
    try {
      await fn();
    } finally {
      setLastRefresh(new Date());
      // Sand + orientation reset when the flip transition ends (see onTransitionEnd)
      // Fallback if transitionend is missed (e.g. tab hidden)
      window.setTimeout(finishFlip, 750);
    }
  };

  // Auto-refresh countdown — pauses when onRefresh is undefined (e.g. QC sheet open)
  useEffect(() => {
    countRef.current = AUTO_REFRESH_SEC;
    setCountdown(AUTO_REFRESH_SEC);
    const id = setInterval(() => {
      if (!onRefreshRef.current) {
        // Halt: keep full while modal/sheet is open; resume fresh when closed
        countRef.current = AUTO_REFRESH_SEC;
        setCountdown(AUTO_REFRESH_SEC);
        return;
      }
      if (flippingRef.current) return; // hold timer while hourglass flips
      countRef.current -= 1;
      setCountdown(countRef.current);
      if (countRef.current <= 0) {
        // Keep drained (0) during flip; reset after rotation finishes
        countRef.current = 0;
        setCountdown(0);
        triggerRefresh();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [onRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtDate = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const fmtShort = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Hourglass: golden sand drains top → bottom; flips 180° on refresh then resets
  const remaining = Math.max(0, countdown) / AUTO_REFRESH_SEC;
  const drained = 1 - remaining;
  const topH = 9.2;
  const botH = 9.2;
  const inverted = orient === 1;
  // After an odd flip the SVG is upside-down — map chambers so "full" stays visually on top
  const topShift = (inverted ? remaining : drained) * topH;
  const botShift = (inverted ? drained : remaining) * botH;
  const showFall = !timerPaused && !flipping && remaining > 0.02 && remaining < 0.98;
  const clipTop = `hg-top-${uid}`;
  const clipBot = `hg-bot-${uid}`;
  const gWood = `hg-wood-${uid}`;
  const gSand = `hg-sand-${uid}`;
  const gGlass = `hg-glass-${uid}`;
  const gShine = `hg-shine-${uid}`;
  const sandMuted = timerPaused;

  const s = {
    bar: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 16,
      flexWrap: 'nowrap',
      minHeight: 'var(--titan-feature-title-height)',
      contain: 'layout',
    },
    title: { color: t.text, fontSize: 18, margin: 0, whiteSpace: 'nowrap' },
    extra: { flex: 1, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
    right: {
      marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10,
      background: t.surface, borderRadius: 10, padding: '6px 14px',
      border: `1px solid ${t.border}`, flexShrink: 0, minHeight: 42,
    },
    lastRefresh: { color: t.textFaint, fontSize: 11, whiteSpace: 'nowrap' },
    shiftBadge: {
      background: t.bg, color: t.brand, fontSize: 11, fontWeight: 700,
      padding: '2px 10px', borderRadius: 10, border: `1px solid ${t.brand}44`,
      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6,
      minWidth: 88, minHeight: 22, justifyContent: 'center',
    },
    refreshBtn: {
      position: 'relative', width: 30, height: 30, borderRadius: 6,
      background: 'none', border: 'none', cursor: timerPaused ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, opacity: timerPaused ? 0.8 : 1, padding: 0,
    },
    countdown: { color: t.textFaint, fontSize: 11, minWidth: 28, textAlign: 'right' },
    clock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, minWidth: 72 },
    time: { color: t.accent, fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.03em' },
    date: { color: t.textDim, fontSize: 10, whiteSpace: 'nowrap' },
  };

  const titleNode = (typeof title === 'string' || typeof title === 'number')
    ? <h3 style={{ ...s.title, color: t.text }}>{title}</h3>
    : <div style={{ ...s.title, color: t.text, display: 'flex', alignItems: 'center', minWidth: 0 }}>{title}</div>;

  return (
    <div style={{ ...s.bar, borderBottom: `1px solid ${t.border}` }}>
      {titleNode}
      {extra && <div style={s.extra}>{extra}</div>}
      <div style={{ ...s.right, background: t.surface, border: `1px solid ${t.border}` }}>
        <span
          style={{
            ...s.shiftBadge,
            background: t.bg,
            borderColor: currentShift ? '#f59e0b44' : t.border,
            color: currentShift ? '#f59e0b' : t.textFaint,
            visibility: currentShift ? 'visible' : 'hidden',
          }}
          aria-hidden={!currentShift}
        >
          <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
            <circle cx={7} cy={7} r={5.5} fill="none" stroke="#f59e0b55" strokeWidth={1.5} />
            <circle
              cx={7} cy={7} r={5.5} fill="none" stroke="#f59e0b" strokeWidth={1.5}
              strokeDasharray={2 * Math.PI * 5.5}
              strokeDashoffset={0}
              strokeLinecap="round"
              transform="rotate(-90 7 7)"
            />
            <circle cx={7} cy={3.2} r={0.9} fill="#f59e0b" />
          </svg>
          {currentShift?.name || 'Shift'}
        </span>
        <NotificationBell />
        <span style={{ ...s.lastRefresh, color: t.textFaint }}>↻ {fmtShort(lastRefresh)}</span>
        <button
          type="button"
          style={s.refreshBtn}
          onClick={triggerRefresh}
          disabled={timerPaused}
          title={
            timerPaused
              ? 'Auto-refresh paused while sheet is open'
              : `Auto-refresh in ${countdown}s — click to refresh now`
          }
        >
          <svg
            width={30}
            height={30}
            viewBox="0 0 30 30"
            aria-hidden="true"
            onTransitionEnd={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.propertyName === 'transform') finishFlip();
            }}
            style={{
              display: 'block',
              transform: `rotate(${flipDeg}deg)`,
              transition: flipping ? 'transform 0.65s cubic-bezier(0.4, 0.05, 0.2, 1)' : 'none',
              transformOrigin: 'center center',
              filter: sandMuted ? 'grayscale(0.55) brightness(1.05)' : 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.28))',
            }}
          >
            <defs>
              {/* Rounded bulb clip regions — match glass paths */}
              <clipPath id={clipTop}>
                <path d="M9.2 4.4 C9.2 8 13.6 12.4 14.7 13.5 C14.95 13.75 15.05 13.75 15.3 13.5 C16.4 12.4 20.8 8 20.8 4.4 Z" />
              </clipPath>
              <clipPath id={clipBot}>
                <path d="M14.7 16.5 C14.95 16.25 15.05 16.25 15.3 16.5 C16.4 17.6 20.8 22 20.8 25.6 L9.2 25.6 C9.2 22 13.6 17.6 14.7 16.5 Z" />
              </clipPath>
              {/* Wood caps */}
              <linearGradient id={gWood} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c48a4a" />
                <stop offset="45%" stopColor="#8b5a2b" />
                <stop offset="100%" stopColor="#5c3a1a" />
              </linearGradient>
              {/* Golden sand */}
              <linearGradient id={gSand} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffe08a" />
                <stop offset="40%" stopColor="#e8b923" />
                <stop offset="100%" stopColor="#c4890a" />
              </linearGradient>
              {/* Glass body tint */}
              <linearGradient id={gGlass} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
                <stop offset="45%" stopColor="#b8d4e8" stopOpacity="0.12" />
                <stop offset="100%" stopColor="#6a8aaa" stopOpacity="0.22" />
              </linearGradient>
              <linearGradient id={gShine} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="35%" stopColor="#ffffff" stopOpacity="0.55" />
                <stop offset="70%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Soft ground shadow */}
            <ellipse cx={15} cy={27.4} rx={7.5} ry={1.1} fill="#000" opacity={0.18} />

            {/* Wooden pillars */}
            <rect x={8.1} y={4.5} width={1.35} height={21} rx={0.55} fill={`url(#${gWood})`} />
            <rect x={20.55} y={4.5} width={1.35} height={21} rx={0.55} fill={`url(#${gWood})`} />

            {/* Top / bottom wood discs */}
            <ellipse cx={15} cy={3.55} rx={8.2} ry={1.55} fill={`url(#${gWood})`} />
            <ellipse cx={15} cy={3.15} rx={8.2} ry={1.2} fill="#d4a066" opacity={0.55} />
            <ellipse cx={15} cy={26.55} rx={8.2} ry={1.55} fill={`url(#${gWood})`} />
            <ellipse cx={15} cy={26.15} rx={8.2} ry={1.2} fill="#d4a066" opacity={0.4} />

            {/* Glass bulbs (filled tint for 3D depth) */}
            <path
              d="M9.2 4.4 C9.2 8 13.6 12.4 14.7 13.5 C14.95 13.75 15.05 13.75 15.3 13.5 C16.4 12.4 20.8 8 20.8 4.4 Z"
              fill={`url(#${gGlass})`}
              stroke="#8aa0b4"
              strokeWidth={0.7}
              strokeLinejoin="round"
            />
            <path
              d="M14.7 16.5 C14.95 16.25 15.05 16.25 15.3 16.5 C16.4 17.6 20.8 22 20.8 25.6 L9.2 25.6 C9.2 22 13.6 17.6 14.7 16.5 Z"
              fill={`url(#${gGlass})`}
              stroke="#8aa0b4"
              strokeWidth={0.7}
              strokeLinejoin="round"
            />
            {/* Neck */}
            <rect x={14.15} y={13.35} width={1.7} height={3.3} rx={0.55} fill={`url(#${gGlass})`} stroke="#8aa0b4" strokeWidth={0.45} />

            {/* Top golden sand */}
            <g clipPath={`url(#${clipTop})`}>
              <rect
                x={8.5}
                y={4.2}
                width={13}
                height={topH}
                fill={`url(#${gSand})`}
                style={{
                  transform: `translateY(${topShift}px)`,
                  transition: !timerPaused && !flipping && remaining < 1 ? 'transform 1s linear' : 'none',
                }}
              />
            </g>

            {/* Bottom golden sand mound */}
            <g clipPath={`url(#${clipBot})`}>
              <rect
                x={8.5}
                y={16.5}
                width={13}
                height={botH}
                fill={`url(#${gSand})`}
                style={{
                  transform: `translateY(${botShift}px)`,
                  transition: !timerPaused && !flipping && remaining < 1 ? 'transform 1s linear' : 'none',
                }}
              />
            </g>

            {/* Falling golden sand stream + grains */}
            {showFall && (
              <g>
                <line
                  x1={15} y1={13.4} x2={15} y2={16.4}
                  stroke="#e8b923" strokeWidth={1.15} strokeLinecap="round" opacity={0.9}
                >
                  <animate attributeName="opacity" values="0.45;1;0.45" dur="0.55s" repeatCount="indefinite" />
                </line>
                <line
                  x1={15} y1={13.4} x2={15} y2={16.4}
                  stroke="#ffe08a" strokeWidth={0.45} strokeLinecap="round" opacity={0.8}
                />
                {[
                  { cx: 14.35, d: '0.5s', b: '0s', r: 0.55 },
                  { cx: 15.55, d: '0.58s', b: '0.12s', r: 0.45 },
                  { cx: 14.85, d: '0.48s', b: '0.28s', r: 0.4 },
                  { cx: 15.2, d: '0.62s', b: '0.4s', r: 0.5 },
                  { cx: 14.55, d: '0.52s', b: '0.18s', r: 0.35 },
                ].map((p, i) => (
                  <circle key={i} cx={p.cx} cy={13.6} r={p.r} fill={i % 2 ? '#ffe08a' : '#d4a017'}>
                    <animate attributeName="cy" values="13.5;16.5" dur={p.d} begin={p.b} repeatCount="indefinite" />
                    <animate attributeName="opacity" values="1;0.15" dur={p.d} begin={p.b} repeatCount="indefinite" />
                  </circle>
                ))}
              </g>
            )}

            {/* Glass highlight (left sheen) for 3D */}
            <path
              d="M10.2 5.2 C10.4 8.2 13.2 11.6 14.3 12.8"
              fill="none"
              stroke={`url(#${gShine})`}
              strokeWidth={1.1}
              strokeLinecap="round"
              opacity={0.75}
            />
            <path
              d="M10.4 17.2 C10.6 20.2 12.8 23.2 14.2 24.6"
              fill="none"
              stroke={`url(#${gShine})`}
              strokeWidth={1}
              strokeLinecap="round"
              opacity={0.55}
            />
          </svg>
        </button>
        <span style={{ ...s.countdown, color: t.textFaint }}>
          {timerPaused ? 'paused' : `${countdown}s`}
        </span>
        <div style={s.clock}>
          <span style={{ ...s.time, color: t.accent }}>{fmt(now)}</span>
          <span style={{ ...s.date, color: t.textDim }}>{fmtDate(now)}</span>
        </div>
      </div>
    </div>
  );
}
