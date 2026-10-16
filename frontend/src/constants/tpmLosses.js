/**
 * TPM 16 Big Losses — shared with tablet for Loss Tracker reason picker.
 * Keep in sync with mobile `constants/losses.js`.
 */
export const EQUIPMENT_ROOT_CAUSES = [
  'Mechanical Failure',
  'Electrical Fault',
  'Operational Error',
  'Material Shortage',
  'Scheduled Maintenance/Clean',
];

export const LOSS9_SUBDIVISIONS = [
  'NO LOAD',
  'NO MANPOWER',
  'POWER CUT',
  'CHIPS REMOVAL',
  'MEETING',
  'LUNCH',
  'TEA',
  'PERSONAL NEEDS',
  'CLITA',
  'TRAINING',
];

export const TPM_LOSS_CATEGORIES = [
  { code: 'LOSS-1', description: 'FAILURE LOSS', label: '1. Equipment Failure', rootCauses: EQUIPMENT_ROOT_CAUSES },
  { code: 'LOSS-2', description: 'SETUP & ADJUSTMENT LOSS', label: '2. Setup & Adjustment' },
  { code: 'LOSS-3', description: 'SETTING CHANGE LOSS', label: '3. Cutting Blade Change' },
  { code: 'LOSS-5', description: 'MINOR STOPPAGE LOSS', label: '5. Minor Stoppages' },
  { code: 'LOSS-9', description: 'MANAGEMENT LOSS', label: '9. Management Loss', subDivisions: LOSS9_SUBDIVISIONS },
  { code: 'LOSS-10', description: 'MOTION LOSS', label: '10. Operating Motion' },
  { code: 'LOSS-13', description: 'MEASUREMENT & ADJUSTMENT LOSS', label: '13. Measurement & Adj.' },
];

export function formatTpmReason(code, description, detail) {
  const parts = [`${code} · ${description}`];
  if (detail) parts.push(detail);
  return parts.join(' · ');
}
