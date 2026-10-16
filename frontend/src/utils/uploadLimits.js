export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export const WI_DOC_ACCEPT = '.pdf,application/pdf,.jpg,.jpeg,.png,.svg,image/jpeg,image/png,image/svg+xml';
export const WI_DOC_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.svg'];

export function formatMaxMb(bytes) {
  return `${bytes / (1024 * 1024)} MB`;
}

export function getWiDocMaxBytes(filename = '') {
  const ext = (filename || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (['.jpg', '.jpeg', '.png', '.svg'].includes(ext)) return MAX_IMAGE_BYTES;
  return MAX_PDF_BYTES;
}

export function isImageDocUrl(url = '') {
  return /\.(jpe?g|png|svg)(\?|#|$)/i.test(url);
}

export function validateFileSize(file, maxBytes, label = 'File') {
  if (!file) return null;
  if (file.size > maxBytes) {
    return `${label} exceeds ${formatMaxMb(maxBytes)} limit (selected: ${formatMaxMb(file.size)})`;
  }
  return null;
}

export function validateWiDocFile(file) {
  if (!file) return null;
  const ext = (file.name || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  if (!WI_DOC_EXTENSIONS.includes(ext)) {
    return 'Allowed formats: PDF, JPEG, PNG, SVG';
  }
  const label = ext === '.pdf' ? 'PDF' : 'Image';
  return validateFileSize(file, getWiDocMaxBytes(file.name), label);
}
