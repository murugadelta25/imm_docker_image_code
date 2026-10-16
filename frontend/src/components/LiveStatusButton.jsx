/** Contained 3D animated machine status button. */

function darken(hex, amount = 0.35) {
  if (!hex || !hex.startsWith('#')) return '#333';
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 0xff) * (1 - amount));
  const g = Math.max(0, ((n >> 8) & 0xff) * (1 - amount));
  const b = Math.max(0, (n & 0xff) * (1 - amount));
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

function lighten(hex, amount = 0.25) {
  if (!hex || !hex.startsWith('#')) return '#fff';
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 255 * amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + 255 * amount);
  const b = Math.min(255, (n & 0xff) + 255 * amount);
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

export default function LiveStatusButton({ status, color, label }) {
  const isRunning = status === 'running';
  const isAlarm = status === 'breakdown' || status === 'alarm';
  const isIdle = status === 'idle';
  const base = darken(color, 0.45);
  const face = color;
  const highlight = lighten(color, 0.35);

  const animClass = isRunning ? 'wi-status--running' : isAlarm ? 'wi-status--alarm' : isIdle ? 'wi-status--idle' : '';

  return (
    <>
      <style>{`
        .wi-status-mount {
          width: 52px;
          height: 52px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .wi-status-3d {
          position: relative;
          width: 40px;
          height: 40px;
          padding: 0;
          border: none;
          background: transparent;
          cursor: default;
          outline: none;
        }
        .wi-status-3d::before {
          content: '';
          position: absolute;
          left: 4px;
          right: 4px;
          bottom: 2px;
          height: 8px;
          border-radius: 50%;
          background: rgba(0,0,0,0.22);
          filter: blur(2px);
          z-index: 0;
        }
        .wi-status-face {
          position: relative;
          z-index: 1;
          display: block;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.55);
          box-sizing: border-box;
          transform: translateY(0);
          will-change: transform;
        }
        .wi-status--running .wi-status-face {
          animation: wi-status-float 1.6s ease-in-out infinite;
        }
        .wi-status--idle .wi-status-face {
          animation: wi-status-float 2.8s ease-in-out infinite;
        }
        .wi-status--alarm .wi-status-face {
          animation: wi-status-alarm 0.85s ease-in-out infinite;
        }
        @keyframes wi-status-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        @keyframes wi-status-alarm {
          0%, 100% { transform: translateY(0); opacity: 1; }
          50% { transform: translateY(-2px); opacity: 0.85; }
        }
      `}</style>
      <div className="wi-status-mount" title={label || status}>
        <button
          type="button"
          className={`wi-status-3d ${animClass}`}
          aria-label={`Machine status: ${label || status}`}
          disabled
        >
          <span
            className="wi-status-face"
            style={{
              background: `radial-gradient(circle at 32% 28%, ${highlight}, ${face} 58%, ${base})`,
              boxShadow: `
                inset 0 3px 6px rgba(255,255,255,0.35),
                inset 0 -4px 6px rgba(0,0,0,0.25),
                0 4px 0 ${base},
                0 4px 8px rgba(0,0,0,0.18)
              `,
            }}
          />
        </button>
      </div>
    </>
  );
}
