/**
 * icsPrint — print an ICS form in the current page.
 *
 * Mounts the form HTML (built by icsForms.js, every value escaped) in a
 * .ics-print-root at the end of <body>, flags body.ics-printing, and calls
 * window.print(). The print stylesheet (styles/icsForms.css) hides the rest
 * of the app, so only the form reaches paper / "Save as PDF". In-page
 * printing avoids pop-up blockers and works the same in the desktop app.
 */
export function printIcsHtml(html, { title = '' } = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const root = document.createElement('div');
  root.className = 'ics-print-root';
  root.innerHTML = html;
  document.body.appendChild(root);
  document.body.classList.add('ics-printing');
  // The browser's "Save as PDF" file name defaults to the document title
  const prevTitle = document.title;
  if (title) document.title = title;

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', cleanup);
    root.remove();
    document.body.classList.remove('ics-printing');
    if (title) document.title = prevTitle;
  };
  window.addEventListener('afterprint', cleanup);
  try {
    window.print();
  } finally {
    // print() blocks until the dialog closes in Chromium and Firefox; Safari
    // returns at once but still fires afterprint. The timer is a safety net
    // for engines that do neither.
    setTimeout(cleanup, 60 * 1000);
  }
}

/** Trigger a CSV download in the browser. */
export function downloadCsv(csv, filename) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
