/**
 * Phase 9.10: the game flow in the game host — title screen, levels in
 * order, lives, pause menu, level complete, game over, the end screen,
 * settings (music/sound volume, quality, key rebinding) and the music that
 * goes with each screen.
 *
 * The controller is driven once per frame by the host with the committed
 * game view and the frame's menu edges. It changes the game only through the
 * runtime's public seams (`startLevel`, `setPaused`) and the audio owner; the
 * menus are plain DOM built with `textContent` only (project strings are
 * never HTML), keyboard/gamepad navigable and clickable.
 */
import type { GameView } from '@thirdlight/runtime';
import type { HostDom, HostDomNode } from './hud';

/** The flow block as the host reads it (structurally; validated by the model). */
export interface FlowConfigLike {
  readonly levels: readonly { readonly id: string; readonly name: string; readonly scenes: readonly string[]; readonly spawnId: string; readonly music?: string }[];
  readonly lives?: { readonly start: number; readonly max: number };
  readonly title?: { readonly subtitle?: string; readonly music?: string };
  readonly hud?: { readonly preset: 'classic' | 'minimal' | 'corners'; readonly timer?: boolean };
  readonly ui?: { readonly font: 'sans' | 'serif' | 'mono' | 'rounded'; readonly accent: string; readonly panel: string; readonly text: string; readonly logo?: string };
  readonly texts?: { readonly levelComplete?: string; readonly gameOver?: string; readonly credits?: string };
  readonly volumes?: { readonly music: number; readonly sfx: number };
}

export type FlowScreen = 'title' | 'playing' | 'paused' | 'settings' | 'levelComplete' | 'gameOver' | 'finished';

/** One frame's menu edges (the input owner's `sampleUi`, plus the menu confirm). */
export interface FlowUiEdges {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly submit: boolean;
  readonly cancel: boolean;
  readonly pause: boolean;
}

/** The observation block (`observe().flow`). */
export interface FlowObservation {
  readonly screen: FlowScreen;
  readonly levelIndex: number;
  readonly levelId: string;
  readonly lives: number | null;
  readonly totals: Readonly<Record<string, number>>;
  readonly music: { readonly assetId: string | null; readonly playing: boolean; readonly gain: number };
  readonly volumes: { readonly music: number; readonly sfx: number };
  readonly quality: 'low' | 'medium' | 'high';
}

export interface FlowDeps {
  readonly flow: FlowConfigLike;
  readonly gameTitle: string;
  readonly objective: string;
  readonly instructions: string;
  readonly dom: HostDom;
  readonly container: HostDomNode;
  readonly runtime: {
    startLevel?(level: { scenes: readonly string[]; spawnId: string }): { ok: true } | { ok: false; error: { message: string } };
    setPaused?(paused: boolean): void;
    gameCounters?(): { counters: Record<string, number>; health: { current: number; max: number } | null };
  };
  readonly audio: {
    playMusic?(assetId: string | null, fadeSeconds?: number): void;
    setVolume?(bus: 'master' | 'music' | 'sfx', value: number): void;
    musicStatus?(): { assetId: string | null; playing: boolean; gain: number };
  };
  /** Rebinding (the input owner's `captureKey` / `configure`, and the current config). */
  readonly input?: {
    captureKey?(onKey: (code: string | null) => void): () => void;
    configure?(config: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[] }): void;
    config?: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[] };
  };
  readonly setQuality?: (level: 'low' | 'medium' | 'high') => void;
}

interface MenuItem {
  readonly id: string;
  label: string;
}

const FONTS: Record<string, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  rounded: '"Nunito", "Varela Round", system-ui, sans-serif',
};

/** Menu and HUD-preset styles (no remote fonts or images; colours from the project's ui block). */
function styleText(flow: FlowConfigLike): string {
  const ui = flow.ui ?? { font: 'sans', accent: '#ffc857', panel: '#1b2330', text: '#f4f1e8' };
  return `
.tl-flow{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:${FONTS[ui.font] ?? FONTS['sans']};color:${ui.text};z-index:5}
.tl-flow.is-hidden{display:none}
.tl-flow__panel{pointer-events:auto;min-width:280px;max-width:min(560px,90%);padding:24px 28px;border-radius:14px;background:${ui.panel}ee;box-shadow:0 10px 40px #0008;text-align:center}
.tl-flow__logo{display:block;max-width:60%;max-height:160px;margin:0 auto 10px}
.tl-flow__logo.is-hidden{display:none}
.tl-flow__title{margin:0 0 6px;font-size:28px;letter-spacing:.02em;color:${ui.accent}}
.tl-flow__line{margin:4px 0;opacity:.9;white-space:pre-line}
.tl-flow__items{display:flex;flex-direction:column;gap:6px;margin-top:16px}
.tl-flow__item{font:inherit;font-size:17px;padding:8px 14px;border-radius:8px;border:2px solid transparent;background:#ffffff14;color:inherit;cursor:pointer}
.tl-flow__item.is-selected{border-color:${ui.accent};background:${ui.accent}33}
.tl-flow-hud .tl-flow-hud__line{font-family:${FONTS[ui.font] ?? FONTS['sans']}}
.tl-hud--minimal h1,.tl-hud--minimal p:not(.tl-flow-hud__line){display:none}
.tl-hud--corners{display:flex;justify-content:space-between;align-items:flex-start;width:100%}
`;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const time = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const REBINDABLE = ['jump', 'attack', 'interact'] as const;

export interface FlowController {
  /** The frame's work; returns true when a menu used the confirm press (the host marks it consumed). */
  frame(view: GameView, ui: FlowUiEdges): boolean;
  /** `control('start')`: a new game from the title (or the ready screen). */
  newGame(): boolean;
  /** `control('replay')`: restart the current level. */
  restartLevel(): boolean;
  observe(): FlowObservation;
  /** The HUD line (level, lives, counters, health, timer) while playing. */
  hudLine(): string;
  /** The menu logo's image URL (the host makes it from the texture bytes). */
  setLogo(url: string): void;
  readonly screen: FlowScreen;
  dispose(): void;
}

export function createFlowController(deps: FlowDeps): FlowController {
  const { flow, dom } = deps;
  const text = (node: HostDomNode, value: string): void => {
    node.textContent = value;
  };
  // --- DOM ---------------------------------------------------------------
  const root = dom.createElement('div');
  root.setAttribute?.('class', 'tl-flow');
  // The menu styles: a constructed stylesheet where the page supports it (the
  // Play page's CSP refuses inline <style>; CSSOM sheets are not inline
  // styles), else a <style> element (tests, older browsers).
  const css = styleText(flow);
  const docLike = dom as unknown as { adoptedStyleSheets?: unknown[] };
  const Sheet = (globalThis as { CSSStyleSheet?: new () => { replaceSync(t: string): void } }).CSSStyleSheet;
  let adopted: unknown = null;
  let style: HostDomNode | null = null;
  if (Array.isArray(docLike.adoptedStyleSheets) && Sheet !== undefined) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      docLike.adoptedStyleSheets = [...docLike.adoptedStyleSheets, sheet];
      adopted = sheet;
    } catch {
      adopted = null;
    }
  }
  if (adopted === null) {
    style = dom.createElement('style');
    text(style, css);
  }
  const panel = dom.createElement('div');
  panel.setAttribute?.('class', 'tl-flow__panel');
  panel.setAttribute?.('role', 'dialog');
  const logoNode = dom.createElement('img');
  logoNode.setAttribute?.('class', 'tl-flow__logo is-hidden');
  logoNode.setAttribute?.('alt', '');
  let logoUrl: string | null = null;
  const titleNode = dom.createElement('h2');
  titleNode.setAttribute?.('class', 'tl-flow__title');
  const linesNode = dom.createElement('div');
  const itemsNode = dom.createElement('div');
  itemsNode.setAttribute?.('class', 'tl-flow__items');
  itemsNode.setAttribute?.('role', 'menu');
  panel.appendChild(logoNode);
  panel.appendChild(titleNode);
  panel.appendChild(linesNode);
  panel.appendChild(itemsNode);
  if (style !== null) root.appendChild(style);
  root.appendChild(panel);
  deps.container.appendChild(root);
  // A click on the menu must not take the keyboard focus from the game
  // surface (the input owner listens there); the click itself still fires.
  const keepFocus = (e?: unknown): void => (e as { preventDefault?: () => void } | undefined)?.preventDefault?.();
  (root.addEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(root, 'mousedown', keepFocus);
  let lineNodes: HostDomNode[] = [];
  let itemNodes: { el: HostDomNode; handler: () => void }[] = [];

  // --- state ---------------------------------------------------------------
  let screen: FlowScreen = 'title';
  let returnTo: FlowScreen = 'title';
  let levelIndex = 0;
  let lives: number | null = null;
  const totals: Record<string, number> = {};
  let items: MenuItem[] = [];
  let selected = 0;
  let lastRunId: string | null = null;
  let seenDeaths = 0;
  let seenLifePickups = 0;
  let levelStartSim: number | null = null;
  let levelResult: { seconds: number; counters: Record<string, number>; deaths: number } | null = null;
  let pendingStart = false;
  let volumes = { music: flow.volumes?.music ?? 0.8, sfx: flow.volumes?.sfx ?? 1 };
  let quality: 'low' | 'medium' | 'high' = 'high';
  let capturing: string | null = null;
  let cancelCapture: (() => void) | null = null;
  let disposed = false;
  let lastView: GameView | null = null;
  deps.audio.setVolume?.('music', volumes.music);
  deps.audio.setVolume?.('sfx', volumes.sfx);

  const level = (): FlowConfigLike['levels'][number] => flow.levels[Math.min(levelIndex, flow.levels.length - 1)]!;

  const bindingOf = (name: string): string => {
    const a = deps.input?.config?.actions.find((x) => x.name === name);
    const b = a?.bindings.find((x) => (x as { kind?: string }).kind === 'key') as { code?: string } | undefined;
    return b?.code ?? '—';
  };

  /** The observable state on the menu root (tests read it in Play and in an export). */
  const stamp = (): void => {
    root.setAttribute?.('data-lives', lives === null ? '' : String(lives));
    const m = deps.audio.musicStatus?.();
    root.setAttribute?.('data-music', m?.assetId ?? '');
    root.setAttribute?.('data-music-gain', m !== undefined ? m.gain.toFixed(2) : '');
    root.setAttribute?.('data-music-playing', m?.playing === true ? 'true' : 'false');
  };

  const render = (): void => {
    root.setAttribute?.('class', screen === 'playing' ? 'tl-flow is-hidden' : 'tl-flow');
    root.setAttribute?.('data-screen', screen);
    root.setAttribute?.('data-level', level().id);
    stamp();
    if (screen === 'playing') return;
    let title = '';
    let lines: string[] = [];
    switch (screen) {
      case 'title':
        title = deps.gameTitle;
        lines = [flow.title?.subtitle ?? deps.objective, deps.instructions].filter((l) => l !== '');
        items = [{ id: 'new', label: 'New game' }, { id: 'settings', label: 'Settings' }];
        break;
      case 'paused':
        title = 'Paused';
        lines = [level().name];
        items = [{ id: 'resume', label: 'Resume' }, { id: 'restart', label: 'Restart level' }, { id: 'settings', label: 'Settings' }, { id: 'quit', label: 'Quit to title' }];
        break;
      case 'settings':
        title = 'Settings';
        lines = capturing !== null ? [`Press a key for ${capturing} (Esc cancels)`] : [];
        items = [
          { id: 'music', label: `Music volume: ${pct(volumes.music)}` },
          { id: 'sfx', label: `Sound volume: ${pct(volumes.sfx)}` },
          { id: 'quality', label: `Quality: ${quality}` },
          ...(deps.input?.captureKey !== undefined ? REBINDABLE.map((n) => ({ id: `bind:${n}`, label: `${n[0]!.toUpperCase()}${n.slice(1)}: ${bindingOf(n)}` })) : []),
          { id: 'back', label: 'Back' },
        ];
        break;
      case 'levelComplete': {
        title = flow.texts?.levelComplete ?? 'Level complete';
        const r = levelResult;
        lines = [level().name, ...(r !== null ? [`Time ${time(r.seconds)}`, ...Object.entries(r.counters).filter(([k]) => k !== 'lives').map(([k, v]) => `${k[0]!.toUpperCase()}${k.slice(1)} ${v}`), `Deaths ${r.deaths}`] : [])];
        items = [{ id: 'next', label: levelIndex + 1 < flow.levels.length ? 'Next level' : 'Finish' }];
        break;
      }
      case 'gameOver':
        title = flow.texts?.gameOver ?? 'Game over';
        lines = [level().name];
        items = [{ id: 'retry', label: 'Retry level' }, { id: 'quit', label: 'Quit to title' }];
        break;
      case 'finished':
        title = `${deps.gameTitle} — finished!`;
        lines = [...Object.entries(totals).filter(([k]) => k !== 'lives').map(([k, v]) => `${k[0]!.toUpperCase()}${k.slice(1)} ${v}`), ...(flow.texts?.credits !== undefined ? [flow.texts.credits] : [])];
        items = [{ id: 'quit', label: 'Back to title' }];
        break;
      default:
        break;
    }
    selected = Math.max(0, Math.min(selected, items.length - 1));
    logoNode.setAttribute?.('class', screen === 'title' && logoUrl !== null ? 'tl-flow__logo' : 'tl-flow__logo is-hidden');
    text(titleNode, title);
    for (const n of lineNodes) n.remove();
    lineNodes = lines.map((l) => {
      const p = dom.createElement('p');
      p.setAttribute?.('class', 'tl-flow__line');
      text(p, l);
      linesNode.appendChild(p);
      return p;
    });
    for (const { el, handler } of itemNodes) {
      el.removeEventListener?.('click', handler);
      el.remove();
    }
    itemNodes = items.map((it, i) => {
      const b = dom.createElement('button');
      b.setAttribute?.('class', i === selected ? 'tl-flow__item is-selected' : 'tl-flow__item');
      b.setAttribute?.('role', 'menuitem');
      b.setAttribute?.('data-item', it.id);
      text(b, it.label);
      const handler = (): void => {
        selected = i;
        activate(it.id, 0);
      };
      b.addEventListener?.('click', handler);
      itemsNode.appendChild(b);
      return { el: b, handler };
    });
  };

  const show = (next: FlowScreen): void => {
    screen = next;
    selected = 0;
    // The title pauses a run left behind (quit to title); a fresh game waits at its start anyway.
    deps.runtime.setPaused?.(next === 'paused' || next === 'settings' || next === 'gameOver' || (next === 'title' && lastView !== null && lastView.state !== 'awaitingStart'));
    if (next === 'title') deps.audio.playMusic?.(flow.title?.music ?? null, 1);
    render();
  };

  const beginLevel = (i: number): boolean => {
    levelIndex = Math.max(0, Math.min(i, flow.levels.length - 1));
    const l = level();
    const r = deps.runtime.startLevel?.({ scenes: l.scenes, spawnId: l.spawnId });
    if (r !== undefined && r.ok === false) {
      console.warn('[game-host] level start failed', r.error.message);
      return false;
    }
    pendingStart = true;
    levelStartSim = null;
    levelResult = null;
    deps.audio.playMusic?.(l.music ?? null, 1);
    show('playing');
    return true;
  };

  const newGame = (): boolean => {
    lives = flow.lives?.start ?? null;
    for (const k of Object.keys(totals)) delete totals[k];
    return beginLevel(0);
  };

  const setVolume = (bus: 'music' | 'sfx', v: number): void => {
    volumes = { ...volumes, [bus]: Math.max(0, Math.min(1, Math.round(v * 10) / 10)) };
    deps.audio.setVolume?.(bus, volumes[bus]);
  };

  const rebind = (name: string): void => {
    const cfg = deps.input?.config;
    if (deps.input?.captureKey === undefined || cfg === undefined) return;
    capturing = name;
    render();
    cancelCapture = deps.input.captureKey((code) => {
      capturing = null;
      cancelCapture = null;
      if (code !== null && deps.input?.config !== undefined) {
        const next = {
          actions: deps.input.config.actions.map((a) => (a.name === name ? { ...a, bindings: [{ kind: 'key', code }, ...a.bindings.filter((b) => (b as { kind?: string }).kind !== 'key')] } : a)),
        };
        deps.input.config = next;
        deps.input.configure?.(next);
      }
      render();
    });
  };

  /** One menu action; `dir` is −1/+1 for left/right on an adjustable item (0: submit). */
  const activate = (id: string, dir: number): void => {
    switch (id) {
      case 'new':
        void newGame();
        return;
      case 'settings':
        returnTo = screen;
        show('settings');
        return;
      case 'resume':
        show('playing');
        return;
      case 'restart':
      case 'retry':
        if (id === 'retry') lives = flow.lives?.start ?? null;
        void beginLevel(levelIndex);
        return;
      case 'quit':
        lives = null;
        show('title');
        return;
      case 'back':
        show(returnTo);
        return;
      case 'next':
        if (levelIndex + 1 < flow.levels.length) void beginLevel(levelIndex + 1);
        else {
          deps.audio.playMusic?.(flow.title?.music ?? null, 1);
          show('finished');
        }
        return;
      case 'music':
      case 'sfx': {
        const v = volumes[id];
        setVolume(id, dir === 0 ? (v >= 1 ? 0 : v + 0.1) : v + dir * 0.1);
        render();
        return;
      }
      case 'quality': {
        const order = ['low', 'medium', 'high'] as const;
        const i = order.indexOf(quality);
        quality = order[(i + (dir < 0 ? 2 : 1)) % 3]!;
        deps.setQuality?.(quality);
        render();
        return;
      }
      default:
        if (id.startsWith('bind:')) rebind(id.slice(5));
    }
  };

  const hudLine = (): string => {
    const parts = [level().name];
    if (lives !== null) parts.push(`Lives ${lives}`);
    const g = deps.runtime.gameCounters?.();
    if (g !== undefined) {
      for (const [k, v] of Object.entries(g.counters)) if (k !== 'defeated' && k !== 'lives') parts.push(`${k[0]!.toUpperCase()}${k.slice(1)} ${v}`);
      if (g.health !== null) parts.push(`Health ${g.health.current}/${g.health.max}`);
    }
    if (flow.hud?.timer === true && lastView !== null && levelStartSim !== null) parts.push(time(Math.max(0, lastView.simTime - levelStartSim)));
    return parts.join(' · ');
  };

  render();
  deps.audio.playMusic?.(flow.title?.music ?? null, 0);

  return {
    get screen() {
      return screen;
    },
    frame(view: GameView, ui: FlowUiEdges): boolean {
      if (disposed) return false;
      lastView = view;
      stamp();
      // A new run (a level start, a retry): count deaths from this run on.
      if (view.runId !== lastRunId) {
        lastRunId = view.runId;
        seenDeaths = view.deathCount;
        seenLifePickups = deps.runtime.gameCounters?.().counters['lives'] ?? 0;
        if (pendingStart && view.state === 'playing') pendingStart = false;
      }
      if (screen === 'playing') {
        if (levelStartSim === null && view.state === 'playing' && !pendingStart) levelStartSim = view.simTime;
        if (pendingStart && view.state === 'playing') {
          pendingStart = false;
          levelStartSim = view.simTime;
        }
        // Lives: a death costs one, an extra-life pickup gives one (up to max).
        if (lives !== null) {
          const extra = (deps.runtime.gameCounters?.().counters['lives'] ?? 0) - seenLifePickups;
          if (extra > 0) {
            lives = Math.min(flow.lives?.max ?? 99, lives + extra);
            seenLifePickups += extra;
          }
          if (view.deathCount > seenDeaths) {
            lives = Math.max(0, lives - (view.deathCount - seenDeaths));
            seenDeaths = view.deathCount;
            if (lives === 0) {
              show('gameOver');
              return false;
            }
          }
        }
        if (view.state === 'won' && !pendingStart) {
          const g = deps.runtime.gameCounters?.();
          const counters = { ...(g?.counters ?? {}) };
          delete counters['defeated'];
          levelResult = { seconds: levelStartSim !== null ? view.simTime - levelStartSim : 0, counters, deaths: view.deathCount };
          for (const [k, v] of Object.entries(counters)) totals[k] = (totals[k] ?? 0) + v;
          show('levelComplete');
          return false;
        }
        if (ui.pause) show('paused');
        return false;
      }
      if (capturing !== null) return false; // the next key goes to the rebinding
      if (ui.up || ui.down) {
        selected = (selected + (ui.down ? 1 : -1) + items.length) % Math.max(1, items.length);
        render();
      }
      const current = items[selected];
      if ((ui.left || ui.right) && current !== undefined && (current.id === 'music' || current.id === 'sfx' || current.id === 'quality')) activate(current.id, ui.left ? -1 : 1);
      if (ui.submit && current !== undefined) {
        activate(current.id, 0);
        return true;
      }
      if (ui.cancel || ui.pause) {
        if (screen === 'paused') show('playing');
        else if (screen === 'settings') show(returnTo);
        return false;
      }
      return false;
    },
    newGame,
    restartLevel: () => beginLevel(levelIndex),
    observe(): FlowObservation {
      const m = deps.audio.musicStatus?.() ?? { assetId: null, playing: false, gain: volumes.music };
      return { screen, levelIndex, levelId: level().id, lives, totals: { ...totals }, music: { assetId: m.assetId, playing: m.playing, gain: m.gain }, volumes: { ...volumes }, quality };
    },
    hudLine,
    setLogo(url: string): void {
      logoUrl = url;
      logoNode.setAttribute?.('src', url);
      render();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelCapture?.();
      (root.removeEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(root, 'mousedown', keepFocus);
      for (const { el, handler } of itemNodes) el.removeEventListener?.('click', handler);
      root.remove();
      if (adopted !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== adopted);
    },
  };
}
