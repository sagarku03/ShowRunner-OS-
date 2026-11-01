/**
 * Pure client-side file download and clipboard utilities (B2).
 */

export function downloadTextFile(fileName: string, content: string): void {
  if (typeof window === 'undefined' || !window.document) return;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 150);
}

export async function downloadFilesAsZip(
  zipFileName: string,
  files: ReadonlyArray<{ fileName: string; content: string }>
): Promise<void> {
  if (typeof window === 'undefined' || !window.document) return;

  const jszipModule = await import('jszip');
  const JSZip = (jszipModule.default || jszipModule) as unknown as typeof import('jszip');
  const zip = new JSZip();

  for (const f of files) {
    zip.file(f.fileName, f.content);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipFileName.endsWith('.zip') ? zipFileName : `${zipFileName}.zip`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 150);
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  // 1. Try modern navigator.clipboard
  if (navigator?.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to textarea fallback
    }
  }

  // 2. Fallback to hidden textarea with execCommand('copy')
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return Boolean(successful);
  } catch {
    return false;
  }
}
