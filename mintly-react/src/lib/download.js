/**
 * Save a Blob to the student's device.
 *
 * A file download that needs an Authorization header cannot be a plain <a href>,
 * so the app fetches the bytes itself (api.budgets.downloadTemplate) and hands
 * them to the browser here. Works on phones too — the browser offers to save or
 * open the .xlsx in whatever spreadsheet app is installed.
 */
export function saveBlob(blob, filename = 'download') {
  if (typeof window === 'undefined') return;
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before releasing the URL.
  window.setTimeout(() => window.URL.revokeObjectURL(url), 10_000);
}
