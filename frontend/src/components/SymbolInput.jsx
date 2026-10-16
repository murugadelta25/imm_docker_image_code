import { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SPEC_SYMBOL_GROUPS, SPEC_SYMBOL_SNIPPETS } from '../utils/gdtSymbols';

/**
 * Text input with insertable engineering / GD&T symbols for specifications.
 */
export default function SymbolInput({
  value,
  onChange,
  style,
  placeholder,
  disabled,
  t,
  title = 'Insert symbol',
}) {
  const inputRef = useRef(null);
  const toggleRef = useRef(null);
  const panelRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(null);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 320 });

  const rememberCaret = () => {
    const el = inputRef.current;
    if (!el) return;
    setCaret({ start: el.selectionStart ?? value?.length ?? 0, end: el.selectionEnd ?? value?.length ?? 0 });
  };

  const placePanel = () => {
    const anchor = toggleRef.current || inputRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(360, Math.max(280, window.innerWidth - 24));
    let left = rect.right - width;
    if (left < 12) left = 12;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    let top = rect.bottom + 6;
    const estHeight = 280;
    if (top + estHeight > window.innerHeight - 12) {
      top = Math.max(12, rect.top - estHeight - 6);
    }
    setPanelPos({ top, left, width });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    placePanel();
    const onReposition = () => placePanel();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (
        panelRef.current?.contains(e.target)
        || inputRef.current?.contains(e.target)
        || toggleRef.current?.contains(e.target)
      ) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const insertText = (text) => {
    const el = inputRef.current;
    const current = value ?? '';
    const start = caret?.start ?? el?.selectionStart ?? current.length;
    const end = caret?.end ?? el?.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
    onChange(next);
    const pos = start + text.length;
    setCaret({ start: pos, end: pos });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const btnStyle = {
    minWidth: 28,
    height: 26,
    padding: '0 6px',
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    background: t.surface,
    color: t.text,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    fontFamily: 'Segoe UI Symbol, Arial Unicode MS, "Noto Sans Symbols", sans-serif',
  };

  const panel = open ? createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: panelPos.top,
        left: panelPos.left,
        width: panelPos.width,
        zIndex: 1200,
        padding: 10,
        borderRadius: 8,
        border: `1px solid ${t.border}`,
        background: t.surface,
        boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
        maxHeight: 'min(320px, calc(100vh - 24px))',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: t.text }}>
          Insert symbol at cursor
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ ...btnStyle, minWidth: 24, fontSize: 12 }}
          title="Close"
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        {SPEC_SYMBOL_SNIPPETS.map((s) => (
          <button
            key={s.label}
            type="button"
            title={s.insert}
            onClick={() => insertText(s.insert)}
            style={{ ...btnStyle, fontSize: 11, minWidth: 'auto', padding: '0 8px' }}
          >
            {s.label}
          </button>
        ))}
      </div>
      {SPEC_SYMBOL_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: t.textDim, marginBottom: 4, fontWeight: 600 }}>
            {group.label}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {group.symbols.map((sym) => (
              <button
                key={`${group.label}-${sym.char}-${sym.name}`}
                type="button"
                title={sym.name}
                onClick={() => insertText(sym.char)}
                style={btnStyle}
              >
                {sym.char}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'stretch', minWidth: 0 }}>
      <input
        ref={inputRef}
        value={value ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onSelect={rememberCaret}
        onKeyUp={rememberCaret}
        onClick={rememberCaret}
        style={{ ...style, flex: 1, minWidth: 0 }}
      />
      <button
        ref={toggleRef}
        type="button"
        title={title}
        disabled={disabled}
        onClick={() => {
          rememberCaret();
          setOpen((v) => !v);
        }}
        style={{
          ...btnStyle,
          flexShrink: 0,
          fontWeight: 700,
          background: open ? `${t.brand}22` : t.surface2,
          borderColor: open ? t.brand : t.border,
        }}
      >
        ±
      </button>
      {panel}
    </div>
  );
}

/** True when a dynamic table column is a specifications-style field. */
export function isSpecColumn(col) {
  if (!col) return false;
  const key = String(col.key || '').toLowerCase();
  const label = String(col.label || '').toLowerCase();
  return key.includes('spec') || label.includes('spec');
}
