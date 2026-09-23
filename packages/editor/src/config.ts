/**
 * Editor page config. The editor page is served by the backend from the
 * authoring origin; the backend injects `window.__thirdlightEditor` (the
 * non-secret `previewOrigin`) when it serves index.html. `authoringOrigin`
 * and the API base are `location.origin` (same-origin with the backend).
 *
 * The backend has one owner token. It is never baked into a page: it is
 * taken once from the URL fragment (`#token=…`, never sent to the server)
 * or the token form, and kept in this browser's localStorage. The project
 * comes from the URL (`?project=<id>`); without one the editor shows the
 * project picker. When the backend served the page to a trusted network
 * (THIRDLIGHT_TRUSTED_NETWORKS) the page config says so and the editor asks
 * for no token: the backend accepts that network's requests without one.
 */

import type { ClientConfig } from './session/client';

export interface EditorPageConfig {
  v: 1;
  previewOrigin: string;
  /** This page was requested from a trusted network: no token needed. */
  trusted?: boolean;
}

/** Sent when no token is stored and the network is trusted (never stored). */
export const TRUSTED_NETWORK_TOKEN = 'trusted-network';

declare global {
  interface Window {
    __thirdlightEditor?: EditorPageConfig;
  }
}

export type ConfigResult =
  | { ok: true; config: ClientConfig }
  /** No token in this browser: show the token form. */
  | { ok: false; needs: 'token'; previewOrigin: string }
  /** Token present, no `?project=`: show the project picker. */
  | { ok: false; needs: 'project'; token: string; previewOrigin: string }
  | { ok: false; needs: 'page'; message: string };

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_KEY = 'thirdlight.token';

function storedToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Remember the owner token in this browser. */
export function rememberToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage unavailable: the token lives only in this page load.
  }
}

/** Forget the stored token (e.g. after the backend rejected it). */
export function forgetToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored
  }
}

/** Read + validate the editor page config (browser-only: uses `location`). */
export function readEditorConfig(): ConfigResult {
  const page = window.__thirdlightEditor;
  if (!page || page.v !== 1 || typeof page.previewOrigin !== 'string' || page.previewOrigin === '') {
    return { ok: false, needs: 'page', message: 'editor config not set — open the editor through the Thirdlight backend' };
  }
  const previewOrigin = page.previewOrigin.replace(/\/$/, '');

  // A `#token=` fragment is consumed once and removed from the address bar.
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (fromHash) {
    rememberToken(fromHash);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const token = fromHash ?? storedToken() ?? (page.trusted === true ? TRUSTED_NETWORK_TOKEN : null);
  if (!token) return { ok: false, needs: 'token', previewOrigin };

  const projectId = new URLSearchParams(window.location.search).get('project') ?? '';
  if (!PROJECT_ID_RE.test(projectId)) return { ok: false, needs: 'project', token, previewOrigin };

  return {
    ok: true,
    config: {
      projectId,
      authoringOrigin: window.location.origin,
      previewOrigin,
      authoringToken: token,
    },
  };
}
