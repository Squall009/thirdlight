/**
 * SPIKE 22.2: stands in for the exporter's generated `thirdlight:export-artifacts`
 * module (one relative fetch per declared path). The spike page is rebuilt
 * after the export, so it reads any relative path; the manifest digests are
 * still checked by the page as in the product.
 */
export const assetPaths: string[] = [];

export function readAsset(path: string, signal?: AbortSignal): Promise<Response> | null {
  return fetch(`./${path}`, { credentials: 'omit', ...(signal !== undefined ? { signal } : {}) });
}
