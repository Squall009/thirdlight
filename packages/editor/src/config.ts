/**
 * Editor page config (packet 10). The editor page is served from the
 * authoring origin; the deployment injects `window.__thirdlightEditor` before
 * `main.js` loads. `authoringOrigin` and the API base are derived at runtime
 * from `location.origin` (the editor is same-origin with the backend); the
 * build/deploy injects `projectId`, `previewOrigin`, and the project-scoped
 * `authoringToken`. If the config is absent/invalid the editor renders a clear
 * "config not set" state (never a silent failure).
 */

import type { ClientConfig } from './session/client';

export interface EditorPageConfig {
  v: 1;
  projectId: string;
  previewOrigin: string;
  authoringToken: string;
}

declare global {
  interface Window {
    __thirdlightEditor?: EditorPageConfig;
  }
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  | { ok: false; message: string };

/** Read + validate the editor page config (browser-only: uses `location`). */
export function readEditorConfig(): ConfigResult {
  const page = window.__thirdlightEditor;
  if (!page) {
    return { ok: false, message: 'editor config not set — inject window.__thirdlightEditor { v: 1, projectId, previewOrigin, authoringToken } before main.js' };
  }
  if (page.v !== 1) return { ok: false, message: 'editor config v must be 1' };
  const origin = window.location.origin;
  if (!page.projectId || typeof page.projectId !== 'string') {
    return { ok: false, message: 'editor config projectId is missing' };
  }
  if (!page.previewOrigin || typeof page.previewOrigin !== 'string') {
    return { ok: false, message: 'editor config previewOrigin is missing' };
  }
  return {
    ok: true,
    config: {
      projectId: page.projectId,
      authoringOrigin: origin,
      previewOrigin: page.previewOrigin.replace(/\/$/, ''),
      authoringToken: page.authoringToken ?? '',
    },
  };
}