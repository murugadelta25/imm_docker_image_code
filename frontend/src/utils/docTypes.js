/** Built-in and custom work-instruction document types. */

export const BUILTIN_DOC_TYPES = [
  { key: 'control_plan', label: 'Control Plan' },
  { key: 'wi_visual', label: 'WI-Visual' },
  { key: 'wi_tray', label: 'WI-Tray' },
  { key: 'breakdown_sheet', label: 'Breakdown Sheet' },
  { key: 'drawing_revision', label: 'Part / Drawing Revision' },
  { key: 'process_sheet_revision', label: 'Process Sheet Revision' },
];

export const OTHER_DOC_TYPE = '__other__';

export function slugifyDocType(label) {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'custom_doc';
}

export function docTypeLabel(docType, docLabel, knownTypes = BUILTIN_DOC_TYPES) {
  if (docLabel && String(docLabel).trim()) return String(docLabel).trim();
  const found = (knownTypes || []).find((d) => d.key === docType);
  if (found?.label) return found.label;
  return String(docType || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function mergeDocTypes(apiTypes = [], extraDocs = []) {
  const map = new Map();
  for (const d of BUILTIN_DOC_TYPES) {
    map.set(d.key, { key: d.key, label: d.label });
  }
  for (const d of apiTypes || []) {
    if (!d?.key) continue;
    map.set(d.key, { key: d.key, label: d.label || docTypeLabel(d.key) });
  }
  for (const d of extraDocs || []) {
    if (!d?.doc_type) continue;
    if (!map.has(d.doc_type)) {
      map.set(d.doc_type, {
        key: d.doc_type,
        label: docTypeLabel(d.doc_type, d.doc_label),
      });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function resolveDocTypeSelection(selectedKey, customLabel) {
  if (selectedKey === OTHER_DOC_TYPE) {
    const label = (customLabel || '').trim();
    if (!label) return { error: 'Enter a name for the new document type' };
    const key = slugifyDocType(label);
    return { key, label };
  }
  if (!selectedKey) return { error: 'Select a document type' };
  const builtin = BUILTIN_DOC_TYPES.find((d) => d.key === selectedKey);
  return { key: selectedKey, label: builtin?.label || docTypeLabel(selectedKey) };
}
