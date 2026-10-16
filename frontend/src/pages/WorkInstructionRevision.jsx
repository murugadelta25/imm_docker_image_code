import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api/client';
import { assetUrl } from '../api/config';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { getWorkInstructionStyles } from '../themes/workInstructionStyles';
import { validateWiDocFile, WI_DOC_ACCEPT, isImageDocUrl } from '../utils/uploadLimits';
import {
  OTHER_DOC_TYPE,
  mergeDocTypes,
  resolveDocTypeSelection,
  docTypeLabel,
} from '../utils/docTypes';

const REV_PAGE_SIZE = 50;

function suggestNextRevision(currentRev) {
  if (!currentRev) return '1';
  const trimmed = String(currentRev).trim();
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && String(num) === trimmed) return String(num + 1);
  const match = trimmed.match(/^([A-Za-z]*)(\d+)$/);
  if (match) return `${match[1]}${parseInt(match[2], 10) + 1}`;
  return trimmed;
}

export default function WorkInstructionRevision() {
  const { theme: t } = useTheme();
  const [parts, setParts] = useState([]);
  const [docTypeOptions, setDocTypeOptions] = useState([]);
  const [partId, setPartId] = useState('');
  const [docType, setDocType] = useState('');
  const [data, setData] = useState({
    current: [], history: [], current_total: 0, history_total: 0, current_page: 1, history_page: 1,
    current_pages: 1, history_pages: 1,
  });
  const [revPage, setRevPage] = useState(1);
  const [pdfUrl, setPdfUrl] = useState(null);

  const [uploadPartId, setUploadPartId] = useState('');
  const [uploadDocType, setUploadDocType] = useState('');
  const [uploadCustomLabel, setUploadCustomLabel] = useState('');
  const [uploadRevision, setUploadRevision] = useState('');
  const [uploadRevDate, setUploadRevDate] = useState(new Date().toISOString().slice(0, 10));
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const s = getWorkInstructionStyles(t);

  const loadParts = useCallback(async () => {
    try {
      const { data: p } = await api.get('/api/parts/options', { params: { active_only: true, limit: 500 } });
      setParts(p);
    } catch {
      setParts([]);
    }
  }, []);

  const loadDocTypes = useCallback(async () => {
    try {
      const { data: types } = await api.get('/api/parts/document-types');
      setDocTypeOptions(mergeDocTypes(types, data.current));
    } catch {
      setDocTypeOptions(mergeDocTypes([], data.current));
    }
  }, [data.current]);

  const loadRevisions = useCallback(async (page = 1) => {
    const params = { page, page_size: REV_PAGE_SIZE };
    if (partId) params.part_id = partId;
    if (docType) params.doc_type = docType;
    try {
      const { data: d } = await api.get('/api/parts/documents/revisions', { params });
      setData(d);
      setRevPage(d.current_page ?? page);
    } catch {
      setData({
        current: [], history: [], current_total: 0, history_total: 0,
        current_page: 1, history_page: 1, current_pages: 1, history_pages: 1,
      });
    }
  }, [partId, docType]);

  useEffect(() => { loadParts(); }, [loadParts]);
  useEffect(() => { setRevPage(1); }, [partId, docType]);
  useEffect(() => { loadRevisions(revPage); }, [partId, docType, revPage, loadRevisions]);
  useEffect(() => { loadDocTypes(); }, [loadDocTypes]);

  const resolvedUploadType = useMemo(() => {
    if (!uploadDocType || uploadDocType === OTHER_DOC_TYPE) return null;
    return uploadDocType;
  }, [uploadDocType]);

  const currentForUpload = useMemo(() => {
    if (!uploadPartId || !resolvedUploadType) return null;
    const fromList = data.current.find(
      (d) => String(d.part_id) === String(uploadPartId) && d.doc_type === resolvedUploadType && d.is_current,
    );
    return fromList || null;
  }, [data, uploadPartId, resolvedUploadType]);

  useEffect(() => {
    if (!uploadPartId || !resolvedUploadType) {
      if (uploadDocType !== OTHER_DOC_TYPE) setUploadRevision('');
      return;
    }
    setUploadRevision(suggestNextRevision(currentForUpload?.revision));
  }, [uploadPartId, resolvedUploadType, currentForUpload?.revision, uploadDocType]);

  const handleUpload = async () => {
    if (!uploadPartId) {
      setUploadMsg('Select a part');
      return;
    }
    const resolved = resolveDocTypeSelection(uploadDocType, uploadCustomLabel);
    if (resolved.error) {
      setUploadMsg(resolved.error);
      return;
    }
    if (!uploadFile) {
      setUploadMsg('Choose a file (PDF, JPEG, PNG, or SVG)');
      return;
    }
    const sizeErr = validateWiDocFile(uploadFile);
    if (sizeErr) {
      setUploadMsg(sizeErr);
      return;
    }
    if (!uploadRevision.trim()) {
      setUploadMsg('Enter revision number');
      return;
    }
    setUploading(true);
    setUploadMsg('');
    try {
      const fd = new FormData();
      fd.append('file', uploadFile);
      const params = {
        revision: uploadRevision.trim(),
        doc_label: resolved.label,
      };
      if (uploadRevDate) params.rev_date = uploadRevDate;
      if (uploadNotes.trim()) params.notes = uploadNotes.trim();
      await api.post(`/api/parts/${uploadPartId}/documents/${resolved.key}/upload`, fd, {
        params,
      });
      setUploadMsg('File uploaded successfully — previous revision archived to history');
      setUploadFile(null);
      setUploadNotes('');
      setUploadCustomLabel('');
      setPartId(String(uploadPartId));
      setDocType(resolved.key);
      setUploadDocType(resolved.key);
      const { data: refreshed } = await api.get('/api/parts/documents/revisions', {
        params: { part_id: uploadPartId, doc_type: resolved.key },
      });
      setData(refreshed);
      await loadParts();
      await loadDocTypes();
    } catch (e) {
      setUploadMsg(e.response?.data?.detail || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const th = { padding: '8px 10px', textAlign: 'left', background: '#1e40af', color: '#fff', fontSize: 12 };
  const td = { padding: '8px 10px', borderBottom: `1px solid ${t.border}`, fontSize: 12 };
  const inp = { ...s.inp };
  const uploadReady = uploadPartId && uploadDocType && uploadFile
    && (uploadDocType !== OTHER_DOC_TYPE || uploadCustomLabel.trim());

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="Work Instruction Revision Control" onRefresh={loadRevisions} />

      <div style={{ ...s.card, padding: 16, marginBottom: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: t.accent }}>
          Upload / Revise Document
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textDim }}>
          Select part and document type (or Other for a new type), enter the new revision, then upload.
          The current version is moved to historic versions automatically. Documents appear on the Work Instruction dashboard.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: t.textDim }}>
            Part *
            <select
              value={uploadPartId}
              onChange={(e) => setUploadPartId(e.target.value)}
              style={{ ...s.selector, marginTop: 4, width: '100%' }}
            >
              <option value="">Select part…</option>
              {parts.map((p) => <option key={p.id} value={p.id}>{p.part_no}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: t.textDim }}>
            Document Type *
            <select
              value={uploadDocType}
              onChange={(e) => setUploadDocType(e.target.value)}
              style={{ ...s.selector, marginTop: 4, width: '100%' }}
              disabled={!uploadPartId}
            >
              <option value="">Select type…</option>
              {docTypeOptions.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
              <option value={OTHER_DOC_TYPE}>Other (new type)…</option>
            </select>
          </label>
          {uploadDocType === OTHER_DOC_TYPE && (
            <label style={{ fontSize: 12, color: t.textDim }}>
              New Document Type Name *
              <input
                type="text"
                value={uploadCustomLabel}
                onChange={(e) => setUploadCustomLabel(e.target.value)}
                placeholder="e.g. Process Sheet Revision"
                style={{ ...inp, marginTop: 4 }}
              />
            </label>
          )}
          <label style={{ fontSize: 12, color: t.textDim }}>
            New Revision *
            <input
              type="text"
              value={uploadRevision}
              onChange={(e) => setUploadRevision(e.target.value)}
              placeholder="e.g. 2"
              style={{ ...inp, marginTop: 4 }}
              disabled={!uploadDocType}
            />
          </label>
          <label style={{ fontSize: 12, color: t.textDim }}>
            Revision Date
            <input
              type="date"
              value={uploadRevDate}
              onChange={(e) => setUploadRevDate(e.target.value)}
              style={{ ...inp, marginTop: 4 }}
              disabled={!uploadDocType}
            />
          </label>
        </div>

        {currentForUpload && (
          <div style={{
            fontSize: 12, color: t.textDim, marginBottom: 12, padding: 10,
            background: t.surface2, borderRadius: 8, border: `1px solid ${t.border}`,
          }}>
            Current version: <strong style={{ color: t.text }}>Rev {currentForUpload.revision}</strong>
            {currentForUpload.rev_date && ` · ${currentForUpload.rev_date}`}
            {' — will be archived when you upload the new file.'}
          </div>
        )}
        {!currentForUpload && uploadPartId && resolvedUploadType && (
          <div style={{ fontSize: 12, color: t.textDim, marginBottom: 12 }}>
            No current document for this part/type — this will be the first version.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end', marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: t.textDim }}>
            Notes (optional)
            <input
              type="text"
              value={uploadNotes}
              onChange={(e) => setUploadNotes(e.target.value)}
              placeholder="Change summary"
              style={{ ...inp, marginTop: 4 }}
              disabled={!uploadDocType}
            />
          </label>
          <label style={{ fontSize: 12, color: t.textDim }}>
            Document File *
            <input
              type="file"
              accept={WI_DOC_ACCEPT}
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              style={{ fontSize: 12, marginTop: 4, display: 'block', maxWidth: 220 }}
              disabled={!uploadDocType}
            />
            <span style={{ fontSize: 10, color: t.textFaint }}>PDF, JPEG, PNG, or SVG</span>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            type="button"
            onClick={handleUpload}
            disabled={uploading || !uploadReady}
            style={s.btnAccent}
          >
            {uploading ? 'Uploading…' : 'Upload New Revision'}
          </button>
          {uploadMsg && (
            <span style={{
              fontSize: 13,
              color: uploadMsg.includes('fail') || uploadMsg.includes('Select') || uploadMsg.includes('Choose') || uploadMsg.includes('Enter')
                ? '#dc2626' : t.brand,
            }}
            >
              {uploadMsg}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          value={partId}
          onChange={(e) => setPartId(e.target.value)}
          style={s.selector}
        >
          <option value="">All Parts</option>
          {parts.map((p) => <option key={p.id} value={p.id}>{p.part_no}</option>)}
        </select>
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
          style={s.selector}
        >
          <option value="">All Document Types</option>
          {docTypeOptions.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>

      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '10px 14px', fontWeight: 700, background: t.surface2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Current Versions</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: t.textDim }}>
            {data.current_total ?? data.current?.length ?? 0} total · page {data.current_page ?? 1} of {data.current_pages ?? 1}
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Part</th>
              <th style={th}>Document</th>
              <th style={th}>Revision</th>
              <th style={th}>Rev Date</th>
              <th style={th}>Status</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.current.filter((d) => d.is_current).map((d) => (
              <tr key={`c-${d.id}`}>
                <td style={td}>{d.part_no}</td>
                <td style={td}>{docTypeLabel(d.doc_type, d.doc_label, docTypeOptions)}</td>
                <td style={td}>{d.revision}</td>
                <td style={td}>{d.rev_date || '—'}</td>
                <td style={td}><span style={{ color: '#16a34a', fontWeight: 600 }}>Current</span></td>
                <td style={td}>
                  {d.file_url && (
                    <button type="button" onClick={() => setPdfUrl(assetUrl(d.file_url))} style={{ cursor: 'pointer', color: '#2563eb' }}>
                      View
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data.current.filter((d) => d.is_current).length === 0 && (
              <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: t.textDim }}>No current documents</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, padding: 10, justifyContent: 'flex-end' }}>
          <button type="button" style={s.btnSecondary} disabled={revPage <= 1} onClick={() => setRevPage((p) => p - 1)}>← Prev</button>
          <button type="button" style={s.btnSecondary} disabled={revPage >= (data.current_pages ?? 1)} onClick={() => setRevPage((p) => p + 1)}>Next →</button>
        </div>
      </div>

      <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px', fontWeight: 700, background: t.surface2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Historic Versions</span>
          <span style={{ fontSize: 11, fontWeight: 500, color: t.textDim }}>
            {data.history_total ?? data.history?.length ?? 0} total · showing up to {REV_PAGE_SIZE} per page
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Part</th>
              <th style={th}>Document</th>
              <th style={th}>Revision</th>
              <th style={th}>Rev Date</th>
              <th style={th}>Archived At</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.history.map((h) => (
              <tr key={`h-${h.id}`}>
                <td style={td}>{h.part_no}</td>
                <td style={td}>{docTypeLabel(h.doc_type, h.doc_label, docTypeOptions)}</td>
                <td style={td}>{h.revision}</td>
                <td style={td}>{h.rev_date || '—'}</td>
                <td style={td}>{h.archived_at ? new Date(h.archived_at).toLocaleString() : '—'}</td>
                <td style={td}>
                  <button type="button" onClick={() => setPdfUrl(assetUrl(h.file_url))} style={{ cursor: 'pointer', color: '#2563eb' }}>
                    View
                  </button>
                </td>
              </tr>
            ))}
            {data.history.length === 0 && (
              <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: t.textDim }}>No historic versions</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pdfUrl && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 900, padding: 16, display: 'flex', flexDirection: 'column' }}>
          <button type="button" onClick={() => setPdfUrl(null)} style={{ alignSelf: 'flex-end', marginBottom: 8, padding: '8px 16px', cursor: 'pointer' }}>Close</button>
          {isImageDocUrl(pdfUrl) ? (
            <img
              src={pdfUrl}
              alt="Work instruction"
              style={{ flex: 1, objectFit: 'contain', borderRadius: 8, background: '#fff' }}
            />
          ) : (
            <iframe title="Document" src={pdfUrl} style={{ flex: 1, border: 'none', borderRadius: 8, background: '#fff' }} />
          )}
        </div>
      )}
    </div>
  );
}
