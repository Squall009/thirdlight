/**
 * Editor page config. The editor page is served by the backend from the
 * authoring origin; the backend injects `window.__thirdlightEditor` (the
 * non-secret `previewOrigin`) when it serves index.html. `authoringOrigin`
 * and the API base are `location.origin` (same-origin with the backend).
 *
 * The project comes from the URL (`?project=<id>`). The project-scoped token
 * is never baked into a page: it is taken once from the URL fragment
 * (`#token=…`, never sent to the server) or the connect form, and kept in
 * this browser's localStorage.
 */

import type { ClientConfig } from './session/client';

export interface EditorPageConfig {
  v: 1;
  previewOrigin: string;
}

declare global {
  interface Window {
    __thirdlightEditor?: EditorPageConfig;
  }
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  /** Project or token missing: show the connect form (prefilled when known). */
  | { ok: false; needsConnect: true; projectId: string; message?: string }
  | { ok: false; needsConnect: false; message: string };

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const tokenKey = (projectId: string): string => `thirdlight.token.${projectId}`;

function storedToken(projectId: string): string | null {
  try {
    return window.localStorage.getItem(tokenKey(projectId));
  } catch {
    return null;
  }
}

/** Remember the token for a project in this browser. */
export function rememberToken(projectId: string, token: string): void {
  try {
    window.localStorage.setItem(tokenKey(projectId), token);
  } catch {
    // Storage unavailable: the token lives only in this page load.
  }
}

/** Forget the stored token (e.g. after the backend rejected it). */
export function forgetToken(projectId: string): void {
  try {
    window.localStorage.removeItem(tokenKey(projectId));
  } catch {
    // nothing stored
  }
}

/** Read + validate the editor page config (browser-only: uses `location`). */
export function readEditorConfig(): ConfigResult {
  const page = window.__thirdlightEditor;
  if (!page || page.v !== 1 || typeof page.previewOrigin !== 'string' || page.previewOrigin === '') {
    return { ok: false, needsConnect: false, message: 'editor config not set — open the editor through the Thirdlight backend' };
  }
  const projectId = new URLSearchParams(window.location.search).get('project') ?? '';
  if (!PROJECT_ID_RE.test(projectId)) return { ok: false, needsConnect: true, projectId: '' };

  // A `#token=` fragment is consumed once and removed from the address bar.
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (fromHash) {
    rememberToken(projectId, fromHash);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const token = fromHash ?? storedToken(projectId);
  if (!token) return { ok: false, needsConnect: true, projectId };

  return {
    ok: true,
    config: {
      projectId,
      authoringOrigin: window.location.origin,
      previewOrigin: page.previewOrigin.replace(/\/$/, ''),
      authoringToken: token,
    },
  };
}
