import { useRef } from 'react';
import { assetUrl } from '../api/config';
import { useTheme } from '../context/ThemeContext';
import { getParamColumnValue } from '../utils/qcColumnSchema';

/** Print only the Process Control Sheet (iframe — avoids blank popup pages). */
export function printProcessControlSheet(rootEl, title = 'Process Control Sheet') {
  if (!rootEl) return;

  const clone = rootEl.cloneNode(true);
  clone.querySelectorAll('[data-print-hide], [data-no-print]').forEach((n) => n.remove());
  clone.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    if (src.startsWith('/')) {
      img.setAttribute('src', `${window.location.origin}${src}`);
    } else if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
      img.setAttribute('src', `${window.location.origin}/${src}`);
    }
  });

  const html = clone.outerHTML;
  if (!html || html.length < 20) {
    window.alert('Nothing to print — open the Process Control Sheet first.');
    return;
  }

  const safeTitle = String(title).replace(/[<>&"]/g, '');
  const docHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body { margin: 0; padding: 0; background: #fff; color: #0f172a;
      font-family: "Segoe UI", Arial, sans-serif; }
    table { border-collapse: collapse; width: 100%; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>${html}</body>
</html>`;

  // Hidden iframe in the same origin — more reliable than window.open + noopener
  const prev = document.getElementById('pcs-print-frame');
  if (prev) prev.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'pcs-print-frame';
  iframe.setAttribute('title', safeTitle);
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(iframe);

  const frameWin = iframe.contentWindow;
  const frameDoc = iframe.contentDocument || frameWin?.document;
  if (!frameDoc || !frameWin) {
    iframe.remove();
    window.alert('Unable to prepare print view.');
    return;
  }

  frameDoc.open();
  frameDoc.write(docHtml);
  frameDoc.close();

  const cleanup = () => {
    setTimeout(() => {
      try { iframe.remove(); } catch { /* ignore */ }
    }, 1000);
  };

  const triggerPrint = () => {
    try {
      frameWin.focus();
      frameWin.print();
    } catch {
      window.alert('Print failed. Try again or use the browser print dialog.');
    } finally {
      cleanup();
    }
  };

  const waitAndPrint = () => {
    const images = [...frameDoc.images];
    if (images.length === 0) {
      setTimeout(triggerPrint, 100);
      return;
    }
    let pending = images.length;
    const done = () => {
      pending -= 1;
      if (pending <= 0) setTimeout(triggerPrint, 100);
    };
    images.forEach((img) => {
      if (img.complete) done();
      else {
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      }
    });
    // Safety timeout if an image never settles
    setTimeout(() => {
      if (pending > 0) triggerPrint();
    }, 3000);
  };

  // Give the browser a tick to parse the written document
  setTimeout(waitAndPrint, 50);
}

const STATUS_OPTS = [
  { key: 'prototype', label: 'PROTOTYPE' },
  { key: 'pre-launch', label: 'PRE-LAUNCH' },
  { key: 'production', label: 'PRODUCTION' },
  { key: 'other', label: 'OTHER' },
];

function cell(border, extra = {}) {
  return {
    border: `1px solid ${border}`,
    padding: '4px 6px',
    fontSize: 11,
    verticalAlign: 'top',
    ...extra,
  };
}

function HeaderCell({ label, value, border, colSpan = 1 }) {
  return (
    <td colSpan={colSpan} style={cell(border)}>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.3 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', marginTop: 2, wordBreak: 'break-word' }}>
        {value || '—'}
      </div>
    </td>
  );
}

function ParamTable({ title, table, border, emptyText = 'No data' }) {
  const columns = table?.columns || [];
  const rows = table?.rows || [];
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        background: '#1e3a5f', color: '#fff', fontSize: 11, fontWeight: 700,
        padding: '4px 8px', letterSpacing: 0.4,
      }}
      >
        {title}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 280 }}>
          <thead>
            <tr>
              <th style={{ ...cell(border), background: '#fef08a', fontSize: 10, fontWeight: 700 }}>#</th>
              {columns.map((c) => (
                <th key={c.key} style={{ ...cell(border), background: '#fef08a', fontSize: 10, fontWeight: 700 }}>
                  {c.label || c.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} style={{ ...cell(border), color: '#64748b', fontStyle: 'italic' }}>
                  {emptyText}
                </td>
              </tr>
            )}
            {rows.map((row, i) => (
              <tr key={i}>
                <td style={cell(border)}>{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.key} style={{ ...cell(border), wordBreak: 'break-word' }}>
                    {row[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Process Control Sheet — dynamic layout from Part Master (matches PCS document).
 */
export default function ProcessControlSheet({
  part,
  qcParameters = [],
  qcColumnSchema = [],
  machineName,
  plan,
  showPrintButton = true,
}) {
  const { theme: t } = useTheme();
  const sheetRef = useRef(null);
  const border = '#94a3b8';
  const status = (part?.manufacturing_status || 'production').toLowerCase();
  const statusLabel = status === 'other'
    ? (part?.manufacturing_status_other || 'OTHER')
    : status;

  const cycleTime = (Number(part?.process_time) || 0) + (Number(part?.loading_unloading) || 0);
  const sheetTitle = `Process Control Sheet — ${part?.part_no || part?.model_variant || 'Part'}`;

  const handlePrint = () => {
    printProcessControlSheet(sheetRef.current, sheetTitle);
  };

  const headerRows = [
    [
      ['Part Name', part?.part_name],
      ['Article Number', part?.part_no || part?.model_variant],
      ['Input Material', part?.input_material],
    ],
    [
      ['Operation Name', part?.operation_name || plan?.current_operation],
      ['Previous Operation', part?.previous_operation],
      ['Next Operation', part?.next_operation || plan?.next_operation],
    ],
    [
      ['Machine Name', machineName || part?.machine_type],
      ['Machine Type', part?.machine_type],
      ['Operation Number', part?.operation_code],
    ],
    [
      ['Work Center / Cell', part?.production_section],
      ['Approx Cycle Time (s)', cycleTime > 0 ? String(cycleTime) : ''],
      ['Part / Drawing Revision', part?.drawing_revision],
    ],
  ];

  return (
    <div>
      {showPrintButton && (
        <div
          data-print-hide="1"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <button
            type="button"
            onClick={handlePrint}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#1e3a5f',
              color: '#fff',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            🖨 Print Sheet
          </button>
        </div>
      )}
      <div
        ref={sheetRef}
        id="process-control-sheet-print"
        style={{
          background: '#fff',
          color: '#0f172a',
          border: `2px solid ${border}`,
          fontFamily: 'Segoe UI, Arial, sans-serif',
        }}
      >
      {/* Title bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: '#0f172a', color: '#fff', padding: '8px 12px',
      }}
      >
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 1 }}>PROCESS CONTROL SHEET</div>
        <div style={{ fontSize: 11, opacity: 0.9 }}>Part Master · Live</div>
      </div>

      {/* Header grid */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {headerRows.map((row, ri) => (
            <tr key={ri}>
              {row.map(([label, value]) => (
                <HeaderCell key={label} label={label} value={value} border={border} />
              ))}
            </tr>
          ))}
          <tr>
            <td colSpan={2} style={cell(border)}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#334155' }}>OPERATION SEQUENCE</div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2, wordBreak: 'break-word' }}>
                {part?.operation_sequence || '—'}
              </div>
            </td>
            <td style={cell(border)}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#334155' }}>MANUFACTURING STATUS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                {STATUS_OPTS.map((o) => {
                  const on = status === o.key || (o.key === 'other' && status === 'other');
                  return (
                    <span key={o.key} style={{ fontSize: 11, fontWeight: on ? 700 : 500 }}>
                      {on ? '☑' : '☐'}{' '}
                      {o.key === 'other' && status === 'other' ? statusLabel.toUpperCase() : o.label}
                    </span>
                  );
                })}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Sketch + images */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 0,
        borderTop: `1px solid ${border}`,
      }}
      >
        <div style={{ ...cell(border), borderTop: 'none', minHeight: 160 }}>
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 6 }}>PART IMAGE</div>
          <div style={{
            height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#f8fafc', border: `1px dashed ${border}`,
          }}
          >
            {part?.image_url ? (
              <img
                src={assetUrl(part.image_url)}
                alt={part.part_no || 'Part'}
                style={{ maxWidth: '100%', maxHeight: 140, objectFit: 'contain' }}
              />
            ) : (
              <span style={{ color: '#94a3b8', fontSize: 12 }}>No part image</span>
            )}
          </div>
        </div>
        <div style={{ ...cell(border), borderTop: 'none', borderLeft: 'none', minHeight: 160 }}>
          <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 6 }}>SKETCH</div>
          <div style={{
            height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#f8fafc', border: `1px dashed ${border}`,
          }}
          >
            {part?.sketch_image_url ? (
              <img
                src={assetUrl(part.sketch_image_url)}
                alt="Sketch"
                style={{ maxWidth: '100%', maxHeight: 140, objectFit: 'contain' }}
              />
            ) : (
              <span style={{ color: '#94a3b8', fontSize: 12 }}>No sketch uploaded</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
            FREE FROM SHARP EDGES, BURRS, CHIPS, DENT, DAMAGE ETC. · Dimensions in mm unless specified.
          </div>
        </div>
      </div>

      {/* Parameter tables */}
      <div style={{ padding: 8, background: '#f8fafc' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 10,
        }}
        >
          <ParamTable title="TOOLS PARAMETERS" table={part?.tools_parameters} border={border} />
          <ParamTable title="MACHINE PARAMETERS" table={part?.machine_parameters} border={border} />
          <ParamTable title="JIGS, FIXTURES & GAUGES" table={part?.jigs_fixtures} border={border} />
        </div>

        {/* Inspection / QC */}
        <div style={{ marginTop: 4 }}>
          <div style={{
            background: '#1e3a5f', color: '#fff', fontSize: 11, fontWeight: 700,
            padding: '4px 8px', letterSpacing: 0.4,
          }}
          >
            INSPECTION PARAMETERS (QC)
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>
                  {['#', 'Check Points', 'Specifications', 'Num', 'LSL', 'USL',
                    ...(qcColumnSchema || []).map((c) => c.label || c.key)].map((h) => (
                    <th key={h} style={{ ...cell(border), background: '#fef08a', fontSize: 10, fontWeight: 700 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(qcParameters || []).length === 0 && (
                  <tr>
                    <td
                      colSpan={6 + (qcColumnSchema?.length || 0)}
                      style={{ ...cell(border), color: '#64748b', fontStyle: 'italic' }}
                    >
                      No inspection parameters defined for this part
                    </td>
                  </tr>
                )}
                {(qcParameters || []).map((q, i) => (
                  <tr key={i}>
                    <td style={cell(border)}>{q.seq_no || i + 1}</td>
                    <td style={{ ...cell(border), wordBreak: 'break-word' }}>{q.parameter}</td>
                    <td style={{ ...cell(border), wordBreak: 'break-word', fontFamily: 'Segoe UI Symbol, Arial, sans-serif' }}>
                      {q.std_value}
                    </td>
                    <td style={cell(border)}>{q.is_numeric ? 'Y' : ''}</td>
                    <td style={cell(border)}>{q.is_numeric && q.lsl != null ? q.lsl : ''}</td>
                    <td style={cell(border)}>{q.is_numeric && q.usl != null ? q.usl : ''}</td>
                    {(qcColumnSchema || []).map((c) => (
                      <td key={c.key} style={{ ...cell(border), wordBreak: 'break-word' }}>
                        {getParamColumnValue(q, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: '#475569', marginTop: 6 }}>
            Note: Recording to be done as per inspection frequency (operator / inspector).
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', justifyContent: 'space-between', padding: '6px 10px',
        borderTop: `1px solid ${border}`, fontSize: 10, color: t.textDim || '#64748b',
        background: '#fff',
      }}
      >
        <span>Process Control Sheet · dynamic from Part Master</span>
        <span>{part?.part_no || part?.model_variant || '—'}</span>
      </div>
      </div>
    </div>
  );
}
