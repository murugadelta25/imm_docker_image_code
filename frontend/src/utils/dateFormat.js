// Shared date formatting — dd-mm-yyyy hh:mm:ss, IST local time

const parseLocal = (value) => {
  if (!value) return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  return new Date(text.replace(' ', 'T').replace(' IST', ''));
};

const pad = n => String(n).padStart(2, '0');

const fmtDDMMYYYY = (d) =>
  `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()}`;

// Format datetime: 07-06-2026 14:30:00
export const formatDateTime = (value) => {
  const date = parseLocal(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  return `${fmtDDMMYYYY(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

// Format date only: 07-06-2026
export const formatDate = (value) => {
  if (!value) return '—';
  const date = parseLocal(value);
  return date && !Number.isNaN(date.getTime()) ? fmtDDMMYYYY(date) : '—';
};
