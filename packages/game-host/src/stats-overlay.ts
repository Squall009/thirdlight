/**
 * The built-in stats overlay: the engine's frame statistics (`ctx.stats`)
 * in a small box in the top-right corner of the game — fps, frame, CPU and
 * GPU times (average / worst over the window; "not measured" without GPU
 * timestamp queries), draw calls, triangles, texture memory against the
 * budget, geometry, objects, the quality level and the frame-rate cap.
 *
 * Engine UI a game opts into: it exists only when the project's
 * `stats_overlay` setting is on (1: shown from the start, 2: hidden until the
 * key), in Play and the export alike. F3 (the common performance-overlay key
 * of PC games, not bound by any engine default) shows and hides it then.
 * Without the setting neither the overlay nor the key exists.
 *
 * Shift+F3 adds the frame profiler's view under the stats (and shows the
 * overlay if it was hidden): each thread's own ms a frame and its busiest
 * categories against the tier's budget, the GPU's pass shares and the last
 * spike, with a button that saves a capture file. The profile is read only
 * while that view shows (once a stats window), so it costs nothing hidden.
 *
 * Plain DOM, `textContent` only; styles as the debug console's (a
 * constructed stylesheet where the page has one, else a `<style>` element).
 */
import type { BehaviorStats, BehaviorStatsTime } from '@thirdlight/runtime';

import type { HostDom, HostDomNode } from './dom';
import type { ProfileReport } from './page-profile';
import { profileCaptureFileName, profileCaptureText, type ProfileCapture } from './profile-capture';
import { profileOverlayLines } from './profile-view';

/** The overlay's key (`KeyboardEvent.code`); with Shift it shows and hides the profiler's view. */
export const STATS_OVERLAY_KEY = 'F3';

/** The `stats_overlay` setting: absent or 0 none, 1 shown from the start, 2 hidden until the key. */
export type StatsOverlayMode = 'off' | 'shown' | 'hidden';
export function statsOverlayModeOf(settings: unknown): StatsOverlayMode {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['stats_overlay'] : undefined;
  return v === 1 ? 'shown' : v === 2 ? 'hidden' : 'off';
}

export interface StatsOverlay {
  readonly shown: boolean;
  setShown(shown: boolean): void;
  /** Whether the profiler's view shows under the stats. */
  readonly profileShown: boolean;
  setProfileShown(shown: boolean): void;
  /** Show a window's stats. */
  update(stats: BehaviorStats): void;
  /** The overlay's lines (tests). */
  lines(): readonly string[];
  dispose(): void;
}

const CSS = `
.tl-stats{position:fixed;right:8px;top:8px;min-width:15em;padding:6px 8px;background:rgba(10,12,16,.78);color:#e5e9f0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-radius:3px;z-index:2147482990;pointer-events:none;white-space:pre}
.tl-stats.is-hidden{display:none}
.tl-stats__profile{margin-top:4px;padding-top:4px;border-top:1px solid rgba(229,233,240,.25)}
.tl-stats__profile.is-hidden{display:none}
.tl-stats__save{pointer-events:auto;margin-top:4px;font:inherit;color:#e5e9f0;background:rgba(255,255,255,.12);border:1px solid rgba(229,233,240,.35);border-radius:3px;padding:1px 6px;cursor:pointer}
`;

const MIB = 1024 * 1024;
const ms = (t: BehaviorStatsTime): string => `${t.avg.toFixed(1)} / ${t.worst.toFixed(1)} ms`;
const mib = (b: number): string => `${(b / MIB).toFixed(1)} MiB`;
const count = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)} k` : String(n));

/** The overlay's text for one window's stats. */
export function statsOverlayLines(s: BehaviorStats): string[] {
  return [
    `${s.fps.toFixed(0)} fps`,
    `frame ${ms(s.frameMs)}`,
    `cpu   ${ms(s.cpuMs)}`,
    `gpu   ${s.gpuMs === null ? 'not measured' : ms(s.gpuMs)}`,
    `draws ${count(s.drawCalls)}  tris ${count(s.triangles)}`,
    `tex   ${mib(s.textureBytes)} / ${mib(s.textureBudgetBytes)}`,
    `geo   ${mib(s.geometryBytes)}`,
    `objects ${count(s.entities)}  quality ${s.quality}${s.frameRateCap !== null ? `  cap ${s.frameRateCap} fps` : ''}`,
  ];
}

/** What the profiler's view reads (absent: the overlay has no profiler view). */
export interface StatsOverlayProfile {
  read(): ProfileReport;
  /** A capture file of the profile now (the host's build and renderer in its header). */
  capture(): ProfileCapture;
}

/** Saves a capture as a file the browser downloads (an object URL on a link; nothing leaves the page). */
function download(dom: HostDom, container: HostDomNode, capture: ProfileCapture): void {
  const urls = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void } }).URL;
  if (typeof urls?.createObjectURL !== 'function' || typeof Blob !== 'function') return;
  const href = urls.createObjectURL(new Blob([profileCaptureText(capture)], { type: 'application/json' }));
  const a = dom.createElement('a');
  a.setAttribute?.('href', href);
  a.setAttribute?.('download', profileCaptureFileName(capture));
  container.appendChild(a);
  (a as unknown as { click?: () => void }).click?.();
  a.remove();
  setTimeout(() => urls.revokeObjectURL?.(href), 1000);
}

export function createStatsOverlay(deps: { readonly dom: HostDom; readonly container: HostDomNode; readonly shown: boolean; readonly profile?: StatsOverlayProfile }): StatsOverlay {
  const { dom } = deps;
  const root = dom.createElement('div');
  root.setAttribute?.('aria-label', 'Engine stats');
  root.setAttribute?.('data-tl-stats', '');
  const docLike = dom as unknown as { adoptedStyleSheets?: unknown[] };
  const Sheet = (globalThis as { CSSStyleSheet?: new () => { replaceSync(t: string): void } }).CSSStyleSheet;
  let adopted: unknown = null;
  if (Array.isArray(docLike.adoptedStyleSheets) && Sheet !== undefined) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(CSS);
      docLike.adoptedStyleSheets = [...docLike.adoptedStyleSheets, sheet];
      adopted = sheet;
    } catch {
      adopted = null;
    }
  }
  const text = dom.createElement('div');
  if (adopted === null) {
    const style = dom.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }
  root.appendChild(text);
  // The profiler's view: its lines and the capture button (made only where the host gives a profile).
  const profileBox = deps.profile !== undefined ? dom.createElement('div') : null;
  const profileText = profileBox !== null ? dom.createElement('div') : null;
  const save = profileBox !== null ? dom.createElement('button') : null;
  let profileShown = false;
  /** Profile reads the view made (tests: none while it is hidden). */
  let profileReads = 0;
  let profileLines: string[] = [];
  if (profileBox !== null && profileText !== null && save !== null) {
    profileBox.setAttribute?.('data-tl-profile', '');
    profileBox.setAttribute?.('data-reads', '0');
    profileText.textContent = 'waiting for the next stats window…';
    save.textContent = 'Save capture';
    save.setAttribute?.('class', 'tl-stats__save');
    save.setAttribute?.('type', 'button');
    save.addEventListener?.('click', () => {
      if (!disposed && deps.profile !== undefined) download(dom, deps.container, deps.profile.capture());
    });
    profileBox.appendChild(profileText);
    profileBox.appendChild(save);
    root.appendChild(profileBox);
  }
  deps.container.appendChild(root);
  let shown = false;
  let disposed = false;
  let current: string[] = ['waiting for the first frames…'];
  text.textContent = current.join('\n');
  const setShown = (next: boolean): void => {
    if (disposed) return;
    shown = next;
    root.setAttribute?.('class', shown ? 'tl-stats' : 'tl-stats is-hidden');
    root.setAttribute?.('data-shown', shown ? 'true' : 'false');
  };
  setShown(deps.shown);
  const setProfileShown = (next: boolean): void => {
    if (disposed || profileBox === null) return;
    profileShown = next;
    profileBox.setAttribute?.('class', profileShown ? 'tl-stats__profile' : 'tl-stats__profile is-hidden');
    profileBox.setAttribute?.('data-shown', profileShown ? 'true' : 'false');
  };
  setProfileShown(false);
  const showProfile = (): void => {
    if (profileText === null || deps.profile === undefined) return;
    profileLines = profileOverlayLines(deps.profile.read());
    profileReads += 1;
    profileBox!.setAttribute?.('data-reads', String(profileReads));
    profileText.textContent = profileLines.join('\n');
  };

  const win = globalThis as { addEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void; removeEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void };
  const onKey = (event: unknown): void => {
    const e = event as { code?: string; repeat?: boolean; target?: unknown; preventDefault?: () => void };
    if (e.code !== STATS_OVERLAY_KEY || e.repeat === true) return;
    // A text field keeps its keys.
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
    if (t !== null && t !== undefined && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true)) return;
    // The browser's own F3 (find again) is not the game's.
    e.preventDefault?.();
    if ((e as { shiftKey?: boolean }).shiftKey === true && profileBox !== null) {
      // The profiler's view brings the overlay with it.
      setProfileShown(!profileShown || !shown);
      setShown(true);
      if (profileShown) showProfile();
      return;
    }
    setShown(!shown);
  };
  win.addEventListener?.('keydown', onKey, true);

  return {
    get shown() {
      return shown;
    },
    setShown,
    get profileShown() {
      return profileShown;
    },
    setProfileShown(next) {
      setProfileShown(next);
      if (profileShown && shown) showProfile();
    },
    update(stats) {
      if (disposed) return;
      current = statsOverlayLines(stats);
      text.textContent = current.join('\n');
      // Read only while the view shows.
      if (shown && profileShown) showProfile();
    },
    lines: () => [...current, ...(shown && profileShown ? profileLines : [])],
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener?.('keydown', onKey, true);
      root.remove();
      if (adopted !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== adopted);
    },
  };
}
