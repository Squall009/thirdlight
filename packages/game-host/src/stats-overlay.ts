/**
 * The built-in stats overlay: the engine's frame statistics (`ctx.stats`)
 * in a small box in the top-right corner of the game — fps, frame, CPU and
 * GPU times (average / worst over the window; "not measured" without GPU
 * timestamp queries), draw calls, triangles, texture memory against the
 * budget, geometry, objects and the quality level.
 *
 * Engine UI a game opts into: it exists only when the project's
 * `stats_overlay` setting is on (1: shown from the start, 2: hidden until the
 * key), in Play and the export alike. F3 (the common performance-overlay key
 * of PC games, not bound by any engine default) shows and hides it then.
 * Without the setting neither the overlay nor the key exists.
 *
 * Plain DOM, `textContent` only; styles as the debug console's (a
 * constructed stylesheet where the page has one, else a `<style>` element).
 */
import type { BehaviorStats, BehaviorStatsTime } from '@thirdlight/runtime';

import type { HostDom, HostDomNode } from './dom';

/** The overlay's key (`KeyboardEvent.code`). */
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
  /** Show a window's stats. */
  update(stats: BehaviorStats): void;
  /** The overlay's lines (tests). */
  lines(): readonly string[];
  dispose(): void;
}

const CSS = `
.tl-stats{position:fixed;right:8px;top:8px;min-width:15em;padding:6px 8px;background:rgba(10,12,16,.78);color:#e5e9f0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-radius:3px;z-index:2147482990;pointer-events:none;white-space:pre}
.tl-stats.is-hidden{display:none}
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
    `objects ${count(s.entities)}  quality ${s.quality}`,
  ];
}

export function createStatsOverlay(deps: { readonly dom: HostDom; readonly container: HostDomNode; readonly shown: boolean }): StatsOverlay {
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

  const win = globalThis as { addEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void; removeEventListener?: (t: string, h: (e: unknown) => void, o?: unknown) => void };
  const onKey = (event: unknown): void => {
    const e = event as { code?: string; repeat?: boolean; target?: unknown; preventDefault?: () => void };
    if (e.code !== STATS_OVERLAY_KEY || e.repeat === true) return;
    // A text field keeps its keys.
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
    if (t !== null && t !== undefined && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true)) return;
    // The browser's own F3 (find again) is not the game's.
    e.preventDefault?.();
    setShown(!shown);
  };
  win.addEventListener?.('keydown', onKey, true);

  return {
    get shown() {
      return shown;
    },
    setShown,
    update(stats) {
      if (disposed) return;
      current = statsOverlayLines(stats);
      text.textContent = current.join('\n');
    },
    lines: () => [...current],
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener?.('keydown', onKey, true);
      root.remove();
      if (adopted !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== adopted);
    },
  };
}
