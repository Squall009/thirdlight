/**
 * How an exported game reads its own files: by the manifest's or catalog's
 * relative path under the export's folder, never a URL, an absolute path or
 * a step out of the export, with no credentials. The page and the
 * simulation worker read with the same rules; what comes back is checked
 * by its reader against the row that names it.
 */

const RELATIVE_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.@-]+)*$/;

/** A reader of the files under `base` (the export's folder: the page's own address). */
export function exportContentReader(base: string): (path: string) => Promise<ArrayBuffer> {
  return (path) => {
    if (!RELATIVE_PATH.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
      return Promise.reject(new Error(`not a relative artifact path: ${path.slice(0, 80)}`));
    }
    return fetch(new URL(path, base), { credentials: 'omit' }).then((res) => {
      if (!res.ok) return Promise.reject(new Error(`artifact read failed for ${path} (HTTP ${String(res.status)})`));
      return res.arrayBuffer();
    });
  };
}
