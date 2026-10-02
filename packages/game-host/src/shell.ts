/**
 * The game shell in the game host — the menus around a game
 * (every game plays as a scene), drawn with the project's
 * UI documents (`content.shell`): a title before play, the pause screen (or
 * the engine's pause panel), settings, controls, save and load screens, and
 * the HUD documents shown while the game plays.
 *
 * The shell changes the game only through the host's seams: the engine pause
 * (no steps while a menu is open), a scene reload, the deprecated run restart
 * and a move along the scene list (UI events on the next input frame, so
 * replays hold), and project saves
 * (a save made by the simulation, a slot loaded by the save service).
 * It knows no game rules.
 *
 * The values it gives UI documents (`$flow.shell`): the screen, the listed
 * scene, whether Continue has a save, each slot's state, the last note and
 * the volumes.
 */
import type { UiAction } from '@thirdlight/runtime';

import type { UiEdges } from './dom';
import type { HostDom, HostDomNode } from './dom';
import type { SaveStorage } from './storage';

export type ShellScreenKey = 'title' | 'pause' | 'settings' | 'controls' | 'save' | 'load';
export type ShellState = ShellScreenKey | 'playing';

/** The shell block as the host reads it (structurally; validated by the model). */
export interface ShellConfigLike {
  readonly screens?: Readonly<Partial<Record<ShellScreenKey, string>>>;
  readonly hud?: readonly string[];
  readonly scenes?: readonly { readonly scene: string; readonly spawn?: string }[];
  readonly pause?: boolean;
  readonly status?: boolean;
}

/** One used project save slot as the shell reads it. */
export interface ShellSlotLike {
  readonly slot: number;
  readonly title: string;
  readonly location: string;
  readonly playSeconds: number;
  readonly savedAt: string;
}

export interface ShellDeps {
  readonly shell: ShellConfigLike;
  /** Draw this UI document as the current screen (null: none). */
  readonly showScreen: (docId: string | null) => void;
  readonly setHud: (docIds: readonly string[]) => void;
  /** The engine pause (no steps while true). */
  readonly setPaused: (on: boolean) => void;
  /** A fresh run (a restart UI event on the next input frame), named by the action that asked for it. */
  readonly restart: (cause: 'restartLevel' | 'newGame' | 'quitToTitle') => void;
  /** A scene's objects as authored again (a reload UI event; absent: the active scene). */
  readonly reloadScene: (sceneId: string | undefined) => void;
  /** Move to an entry of the scene list (a scene UI event on the next input frame). */
  readonly goToScene: (index: number) => void;
  /** The scene list entry the run is at (-1: none). */
  readonly listedScene: () => number;
  /** Project saves (null: the project declares no save schema). */
  readonly saves: {
    readonly slotCount: number;
    slots(): readonly ShellSlotLike[];
    /** Make a save now (null: asked; else why not). */
    save(slot: number, meta: { title: string; location: string; thumbnail: boolean }): string | null;
    load(slot: number): void;
  } | null;
  /** Whether the pause may open now (a game mode may forbid it). */
  readonly pauseAllowed: () => boolean;
  /** A game mode's own pause screen (absent: the shell's). */
  readonly modePauseScreen: () => string | undefined;
  /** The engine's pause panel (Resume only), made on first use (null: no DOM). */
  readonly pausePanel: () => { show(): void; hide(): void; readonly shown: boolean; handleEdges(e: { up: boolean; down: boolean; submit: boolean; cancel: boolean }): void } | null;
  readonly setVolume?: (bus: 'music' | 'sfx' | 'ui', value: number) => void;
  readonly setQuality?: (q: 'low' | 'medium' | 'high') => void;
  /** Where the volumes and quality the player set are kept (absent: this session only). */
  readonly storage?: SaveStorage;
  readonly namespace: string;
  /** The generated input prompts (the debug status line). */
  readonly prompts: () => string;
  /** The debug status line's document (absent: none). */
  readonly dom?: HostDom;
  readonly container?: HostDomNode;
  readonly log: (message: string) => void;
}

export interface ShellObservation {
  readonly screen: ShellState;
  /** The scene list entry the run is at (-1: none) and its scene. */
  readonly scene: { readonly index: number; readonly id: string | null };
  readonly hud: readonly string[];
  readonly note: string;
}

export interface ShellController {
  /** Show the first screen (the title, else play; `inPlay`: play at once). */
  start(inPlay?: boolean): void;
  engine(action: Extract<UiAction, { do: 'engine' }>): void;
  /** The frame's ui edges the UI documents left (pause, cancel; the pause panel's navigation). */
  handleEdges(edges: UiEdges): void;
  readonly screen: ShellState;
  /** `$flow.shell`. */
  values(): Readonly<Record<string, unknown>>;
  observe(): ShellObservation;
  dispose(): void;
}

const QUALITIES = ['low', 'medium', 'high'] as const;

export function createShellController(deps: ShellDeps): ShellController {
  const shell = deps.shell;
  const screens = shell.screens ?? {};
  const hud = shell.hud ?? [];
  const list = shell.scenes ?? [];
  let screen: ShellState = 'playing';
  let stack: ShellState[] = [];
  let note = '';
  let disposed = false;
  const settingsKey = `${deps.namespace}:shell-settings`;
  let volumes = { music: 1, sfx: 1, ui: 1 };
  let quality: (typeof QUALITIES)[number] = 'high';
  try {
    const raw = deps.storage?.get(settingsKey) ?? null;
    if (raw !== null && raw.length < 4096) {
      const v = JSON.parse(raw) as { volumes?: Record<string, unknown>; quality?: unknown };
      for (const k of ['music', 'sfx', 'ui'] as const) {
        const x = v.volumes?.[k];
        if (typeof x === 'number' && x >= 0 && x <= 1) {
          volumes[k] = x;
          deps.setVolume?.(k, x);
        }
      }
      if ((QUALITIES as readonly unknown[]).includes(v.quality)) {
        quality = v.quality as (typeof QUALITIES)[number];
        deps.setQuality?.(quality);
      }
    }
  } catch {
    // a damaged record: the defaults
  }
  const keepSettings = (): void => {
    try {
      deps.storage?.set(settingsKey, JSON.stringify({ volumes, quality }));
    } catch {
      // storage full or refused: the settings still apply for this session
    }
  };

  // The debug status line (shell.status).
  let statusNode: HostDomNode | null = null;
  let statusText = '';
  if (shell.status === true && deps.dom !== undefined && deps.container !== undefined) {
    statusNode = deps.dom.createElement('div');
    statusNode.setAttribute?.('data-tl-shell-status', '');
    const st = (statusNode as { style?: { cssText?: string } }).style;
    if (st !== undefined) st.cssText = 'position:fixed;left:8px;bottom:8px;z-index:7;padding:3px 8px;border-radius:6px;background:#000a;color:#f4f1e8;font:12px system-ui,sans-serif;pointer-events:none';
    deps.container.appendChild(statusNode);
  }
  const listedId = (i: number): string | null => list[i]?.scene ?? null;
  const paintStatus = (): void => {
    if (statusNode === null) return;
    const i = deps.listedScene();
    const t = [screen, listedId(i) !== null ? `scene ${listedId(i)}` : '', deps.prompts()].filter((x) => x !== '').join(' · ');
    if (t !== statusText) {
      statusText = t;
      statusNode.textContent = t;
    }
  };

  let panel: ReturnType<ShellDeps['pausePanel']> = null;
  const docFor = (s: ShellState): string | undefined => (s === 'playing' ? undefined : s === 'pause' ? (deps.modePauseScreen() ?? screens.pause) : screens[s]);
  const go = (s: ShellState): void => {
    screen = s;
    deps.setPaused(s !== 'playing');
    const doc = docFor(s);
    deps.showScreen(doc ?? null);
    if (s === 'pause' && doc === undefined) {
      panel ??= deps.pausePanel();
      panel?.show();
    } else if (panel?.shown === true) panel.hide();
    deps.setHud(s === 'playing' ? hud : []);
    paintStatus();
  };
  const play = (): void => {
    stack = [];
    go('playing');
  };
  const open = (s: ShellScreenKey): void => {
    if (s === 'title') return toTitle();
    if (s === 'pause') return pause();
    if (screens[s] === undefined) {
      deps.log(`the shell has no ${s} screen (Game shell → Screens)`);
      return;
    }
    if (screen === s) return;
    stack.push(screen);
    go(s);
  };
  const back = (): void => {
    const prev = stack.pop();
    if (prev !== undefined) go(prev);
    else if (screen === 'pause') play();
  };
  const pause = (): void => {
    if (screen !== 'playing' || shell.pause === false || !deps.pauseAllowed()) return;
    stack = [];
    go('pause');
  };
  const toTitle = (): void => {
    deps.restart('quitToTitle');
    stack = [];
    go(screens.title !== undefined ? 'title' : 'playing');
  };
  const newGame = (): void => {
    deps.restart('newGame');
    if (list.length > 0) deps.goToScene(0);
    note = '';
    play();
  };
  const newestSlot = (): number | null => {
    const slots = deps.saves?.slots() ?? [];
    let best: ShellSlotLike | null = null;
    for (const s of slots) if (best === null || s.savedAt > best.savedAt) best = s;
    return best?.slot ?? null;
  };
  const slotOf = (raw: string | undefined): number | null => {
    const n = Number(raw);
    return raw !== undefined && Number.isInteger(n) && n >= 1 && n <= (deps.saves?.slotCount ?? 0) ? n : null;
  };
  const load = (slot: number): void => {
    if (deps.saves === null) return;
    deps.saves.load(slot);
    note = `Loaded slot ${slot}`;
    play();
  };
  const save = (slot: number): void => {
    if (deps.saves === null) return;
    const i = deps.listedScene();
    const problem = deps.saves.save(slot, { title: '', location: listedId(i) ?? '', thumbnail: true });
    note = problem === null ? `Saved to slot ${slot}` : `Not saved: ${problem}`;
    if (problem !== null) deps.log(`save to slot ${slot}: ${problem}`);
  };
  const setVolume = (k: 'music' | 'sfx' | 'ui', v: number): void => {
    volumes = { ...volumes, [k]: Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 };
    deps.setVolume?.(k, volumes[k]);
    keepSettings();
  };

  return {
    start(inPlay = false): void {
      if (screens.title !== undefined && !inPlay) go('title');
      else play();
    },
    get screen(): ShellState {
      return screen;
    },
    engine(a): void {
      if (disposed) return;
      switch (a.action) {
        case 'resume':
          // From the title too: a game that builds its own new game (a UI event its script answers) leaves the title with it.
          play();
          return;
        case 'back':
          back();
          return;
        case 'pause':
          pause();
          return;
        case 'newGame':
          newGame();
          return;
        case 'continue': {
          const slot = newestSlot();
          if (slot === null) note = 'No save to continue';
          else load(slot);
          return;
        }
        case 'restartLevel':
          deps.restart('restartLevel');
          play();
          return;
        case 'reloadScene':
          // A primitive: it leaves the screen as it is (a button that also resumes lists resume too).
          deps.reloadScene(a.scene);
          return;
        case 'quitToTitle':
          toTitle();
          return;
        case 'nextScene': {
          const next = deps.listedScene() + 1;
          if (next >= list.length) {
            deps.log('the scene list has no next scene');
            return;
          }
          deps.goToScene(next);
          if (screen !== 'playing') play();
          return;
        }
        case 'settings':
          open('settings');
          return;
        case 'open':
          if (a.screen !== undefined) open(a.screen);
          return;
        case 'load': {
          const slot = slotOf(a.slot);
          if (slot !== null) load(slot);
          else if (a.slot === undefined) open('load');
          return;
        }
        case 'save': {
          const slot = slotOf(a.slot);
          if (slot !== null) save(slot);
          else if (a.slot === undefined) open('save');
          return;
        }
        case 'setSetting': {
          const k = a.setting;
          if (k === 'music' || k === 'sfx' || k === 'ui') setVolume(k, typeof a.value === 'number' ? a.value : volumes[k] + (a.step ?? 1) * 0.1);
          else if (k === 'quality') {
            if (typeof a.value === 'string' && (QUALITIES as readonly string[]).includes(a.value)) quality = a.value as (typeof QUALITIES)[number];
            else quality = QUALITIES[(QUALITIES.indexOf(quality) + ((a.step ?? 1) < 0 ? 2 : 1)) % 3]!;
            deps.setQuality?.(quality);
            keepSettings();
          }
          return;
        }
        default:
          return; // actions the shell does not own (mute and rebinding are the host's)
      }
    },
    handleEdges(e): void {
      if (disposed) return;
      if (e.pause) {
        if (screen === 'playing') pause();
        else if (screen === 'pause') play();
        else if (screen !== 'title') back();
        return;
      }
      if (screen === 'pause' && panel?.shown === true) {
        panel.handleEdges(e);
        return;
      }
      if (e.cancel && screen !== 'title' && screen !== 'playing') back();
      // A title without a focusable button starts on the confirm.
      else if (e.submit && screen === 'title') newGame();
      paintStatus();
    },
    values(): Readonly<Record<string, unknown>> {
      const i = deps.listedScene();
      const slots = deps.saves?.slots() ?? [];
      const saves: Record<string, unknown> = {};
      for (let n = 1; n <= (deps.saves?.slotCount ?? 0); n += 1) {
        const s = slots.find((x) => x.slot === n);
        const mins = s === undefined ? 0 : Math.floor(s.playSeconds / 60);
        const secs = s === undefined ? 0 : Math.floor(s.playSeconds % 60);
        saves[String(n)] = s === undefined ? { used: false, label: `Slot ${n} — empty` } : { used: true, label: `Slot ${n} — ${s.location !== '' ? `${s.location} ` : ''}${mins}:${String(secs).padStart(2, '0')}`, savedAt: s.savedAt, playSeconds: s.playSeconds, location: s.location };
      }
      return {
        screen,
        scene: { index: i, id: listedId(i), count: list.length, last: i >= list.length - 1 },
        canContinue: newestSlot() !== null,
        saves,
        note,
        volumes: { ...volumes },
        quality,
      };
    },
    observe(): ShellObservation {
      const i = deps.listedScene();
      return { screen, scene: { index: i, id: listedId(i) }, hud: screen === 'playing' ? [...hud] : [], note };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      statusNode?.remove();
    },
  };
}
