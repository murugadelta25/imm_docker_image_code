/**
 * Save a blob response as a file — validates XLSX before download.
 */
export async function downloadBlobResponse(response, filename) {
  const contentType = response.headers?.get?.('content-type') || '';
  const blob = await response.blob();

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await blob.text();
      const parsed = JSON.parse(text);
      detail = parsed.detail || text.slice(0, 200);
    } catch {
      /* ignore parse errors */
    }
    throw new Error(detail);
  }

  if (
    blob.size < 4 ||
    (contentType && !contentType.includes('spreadsheet') && !contentType.includes('octet-stream') && contentType.includes('json'))
  ) {
    const text = await blob.text();
    throw new Error(text.slice(0, 200) || 'Invalid file response');
  }

  const header = await blob.slice(0, 2).text();
  if (header !== 'PK') {
    throw new Error('Downloaded file is not a valid Excel workbook');
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Axios blob download helper */
export async function downloadAxiosBlob(response, filename) {
  const contentType = response.headers?.['content-type'] || '';
  const blob = response.data;

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (contentType.includes('json')) {
    const text = await blob.text();
    throw new Error(text.slice(0, 200));
  }

  const header = await blob.slice(0, 2).text();
  if (header !== 'PK') {
    throw new Error('Downloaded file is not a valid Excel workbook');
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
