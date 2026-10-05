/**
 * The game shell controller — its screens and their return
 * path, the engine pause it holds, New game / Continue / Next scene through
 * the host's seams, saves and loads of numbered slots, the volumes a player
 * sets (kept in storage), and a game mode that forbids the pause.
 */
import { describe, expect, it } from 'vitest';

import { createShellController, type ShellConfigLike, type ShellDeps } from './shell';

const NONE = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };

function harness(shell: ShellConfigLike, over: Partial<ShellDeps> = {}) {
  const log: string[] = [];
  const state = { screen: null as string | null, hud: [] as readonly string[], paused: false, held: false, listed: 0, panel: false, allowed: true };
  const kv = new Map<string, string>();
  const slots: { slot: number; title: string; location: string; playSeconds: number; savedAt: string }[] = [];
  const deps: ShellDeps = {
    shell,
    showScreen: (d) => (state.screen = d),
    setHud: (ids) => (state.hud = ids),
    setPaused: (on) => (state.paused = on),
    setHold: (on) => (state.held = on),
    restart: (cause) => log.push(`restart ${cause}`),
    sceneOp: (op, sceneId) => log.push(`${op} ${sceneId ?? '(active)'}`),
    goToScene: (i) => {
      log.push(`scene ${i}`);
      state.listed = i;
    },
    listedScene: () => state.listed,
    saves: {
      slotCount: 3,
      slots: () => slots,
      save: (slot, meta) => {
        log.push(`save ${slot} ${meta.location}`);
        slots.push({ slot, title: '', location: meta.location, playSeconds: 75, savedAt: `2026-09-28T00:00:0${slots.length}Z` });
        return null;
      },
      load: (slot) => log.push(`load ${slot}`),
    },
    pauseAllowed: () => state.allowed,
    modePauseScreen: () => undefined,
    pausePanel: () => ({
      show: () => (state.panel = true),
      hide: () => (state.panel = false),
      get shown() {
        return state.panel;
      },
      handleEdges: () => log.push('panel edges'),
    }),
    storage: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v), remove: (k) => void kv.delete(k) },
    namespace: 'ns',
    prompts: () => 'A/D move',
    log: (m) => log.push(`log ${m}`),
    ...over,
  };
  return { ctl: createShellController(deps), state, log, kv, slots };
}

describe('the game shell controller', () => {
  it('a screen whose scripts run holds the game instead of pausing it; play lets it go', () => {
    const { ctl, state } = harness({ screens: { title: 'title', settings: 'set' }, simulate: { title: 'scripts' } });
    ctl.start();
    expect([ctl.screen, state.paused, state.held]).toEqual(['title', false, true]);
    ctl.engine({ do: 'engine', action: 'open', screen: 'settings' });
    expect([ctl.screen, state.paused, state.held]).toEqual(['settings', true, false]);
    ctl.engine({ do: 'engine', action: 'back' });
    expect([ctl.screen, state.paused, state.held]).toEqual(['title', false, true]);
    ctl.engine({ do: 'engine', action: 'resume' });
    expect([ctl.screen, state.paused, state.held]).toEqual(['playing', false, false]);
  });

  it('starts at the title (held), New game restarts at the first listed scene and shows the HUD', () => {
    const { ctl, state, log } = harness({ screens: { title: 'title' }, hud: ['hud'], scenes: [{ scene: 'a' }, { scene: 'b' }] });
    ctl.start();
    expect([ctl.screen, state.screen, state.paused, state.hud]).toEqual(['title', 'title', true, []]);
    ctl.engine({ do: 'engine', action: 'newGame' });
    expect([ctl.screen, state.screen, state.paused, state.hud]).toEqual(['playing', null, false, ['hud']]);
    expect(log).toEqual(['restart newGame', 'scene 0']);
    ctl.engine({ do: 'engine', action: 'nextScene' });
    expect(log.slice(-1)).toEqual(['scene 1']);
    ctl.engine({ do: 'engine', action: 'nextScene' });
    expect(log.slice(-1)).toEqual(['log the scene list has no next scene']);
    expect(ctl.values()['scene']).toEqual({ index: 1, id: 'b', count: 2, last: true });
  });

  it('resume leaves the title for play without a restart (a game that builds its own new game)', () => {
    const { ctl, state, log } = harness({ screens: { title: 'title' }, hud: ['hud'] });
    ctl.start();
    expect(ctl.screen).toBe('title');
    ctl.engine({ do: 'engine', action: 'resume' });
    expect([ctl.screen, state.paused, state.hud]).toEqual(['playing', false, ['hud']]);
    expect(log).toEqual([]);
  });

  it('the scene actions reload (absent: the active scene), load and unload a scene and leave the screen as it is; the run restarts name their action', () => {
    const { ctl, state, log } = harness({});
    ctl.start();
    ctl.handleEdges({ ...NONE, pause: true });
    expect([ctl.screen, state.panel]).toEqual(['pause', true]);
    ctl.engine({ do: 'engine', action: 'reloadScene', scene: 'level-2' });
    ctl.engine({ do: 'engine', action: 'reloadScene' });
    ctl.engine({ do: 'engine', action: 'loadScene', scene: 'title' });
    ctl.engine({ do: 'engine', action: 'unloadScene', scene: 'level-2' });
    expect([ctl.screen, state.paused]).toEqual(['pause', true]);
    ctl.engine({ do: 'engine', action: 'restartLevel' });
    expect(ctl.screen).toBe('playing');
    ctl.engine({ do: 'engine', action: 'quitToTitle' });
    expect(log).toEqual(['reload level-2', 'reload (active)', 'load title', 'unload level-2', 'restart restartLevel', 'restart quitToTitle']);
  });

  it('without a title plays at once; the pause input opens the pause panel, sub-screens return where they were opened', () => {
    const { ctl, state } = harness({ screens: { settings: 'opts', save: 'saves' } });
    ctl.start();
    expect(ctl.screen).toBe('playing');
    ctl.handleEdges({ ...NONE, pause: true });
    expect([ctl.screen, state.paused, state.panel, state.screen]).toEqual(['pause', true, true, null]);
    ctl.engine({ do: 'engine', action: 'open', screen: 'settings' });
    expect([ctl.screen, state.screen, state.panel]).toEqual(['settings', 'opts', false]);
    ctl.engine({ do: 'engine', action: 'save' });
    expect(ctl.screen).toBe('save');
    ctl.handleEdges({ ...NONE, cancel: true });
    expect(ctl.screen).toBe('settings');
    ctl.engine({ do: 'engine', action: 'back' });
    expect([ctl.screen, state.panel]).toEqual(['pause', true]);
    ctl.engine({ do: 'engine', action: 'open', screen: 'controls' });
    expect(ctl.screen).toBe('pause'); // no controls screen: logged, nothing opens
    ctl.handleEdges({ ...NONE, pause: true });
    expect([ctl.screen, state.paused, state.panel]).toEqual(['playing', false, false]);
  });

  it('saves and loads numbered slots; Continue loads the newest; the slots are UI values', () => {
    const { ctl, log } = harness({ scenes: [{ scene: 'a' }] });
    ctl.start();
    expect(ctl.values()['canContinue']).toBe(false);
    ctl.engine({ do: 'engine', action: 'continue' });
    expect(ctl.values()['note']).toBe('No save to continue');
    ctl.engine({ do: 'engine', action: 'save', slot: '2' });
    ctl.engine({ do: 'engine', action: 'save', slot: '1' });
    ctl.engine({ do: 'engine', action: 'save', slot: 'auto' });
    expect(log).toEqual(['save 2 a', 'save 1 a']);
    expect((ctl.values()['saves'] as Record<string, { label: string }>)['1']!.label).toBe('Slot 1 — a 1:15');
    expect((ctl.values()['saves'] as Record<string, { used: boolean }>)['3']!.used).toBe(false);
    ctl.handleEdges({ ...NONE, pause: true });
    ctl.engine({ do: 'engine', action: 'continue' });
    expect(log.slice(-1)).toEqual(['load 1']);
    expect(ctl.screen).toBe('playing');
  });

  it('keeps the volumes a player sets, and a mode that forbids the pause keeps it closed', () => {
    const volumes: string[] = [];
    const first = harness({}, { setVolume: (b, v) => volumes.push(`${b}=${v}`) });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'music', step: -1 });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'sfx', value: 0.25 });
    expect(volumes).toEqual(['music=0.9', 'sfx=0.25']);
    const again = harness({}, { storage: { get: (k) => first.kv.get(k) ?? null, set: () => undefined, remove: () => undefined }, setVolume: (b, v) => volumes.push(`again ${b}=${v}`) });
    expect((again.ctl.values()['volumes'] as Record<string, number>)['music']).toBe(0.9);
    expect(volumes.slice(2)).toEqual(['again music=0.9', 'again sfx=0.25', 'again ui=1']);
    const held = harness({});
    held.ctl.start();
    held.state.allowed = false;
    held.ctl.handleEdges({ ...NONE, pause: true });
    expect(held.ctl.screen).toBe('playing');
    const off = harness({ pause: false });
    off.ctl.start();
    off.ctl.engine({ do: 'engine', action: 'pause' });
    expect(off.ctl.screen).toBe('playing');
  });

  it('sets the frame-rate cap a player picks (a value or a step from the game\'s), keeps it, and applies it again next time', () => {
    let cap: number | null = 60;
    const applied: (number | null)[] = [];
    const deps = { frameRateCap: () => cap, setFrameRateCap: (fps: number | null) => void applied.push((cap = fps)) };
    const first = harness({}, deps);
    // A player who never chose leaves the game's cap alone.
    expect(applied).toEqual([]);
    expect(first.ctl.values()['frameRateCap']).toBe(60);
    // A step moves from the cap in effect along 30 → 60 → 120 → none.
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap' });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap', step: 1 });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap', step: 1 });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap', value: 'none' });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap', value: 30 });
    first.ctl.engine({ do: 'engine', action: 'setSetting', setting: 'frameRateCap', value: 45 });
    expect(applied).toEqual([120, null, 30, null, 30]);
    expect(first.ctl.values()['frameRateCap']).toBe(30);
    cap = null;
    const again = harness({}, { ...deps, storage: { get: (k) => first.kv.get(k) ?? null, set: () => undefined, remove: () => undefined } });
    expect(applied.at(-1)).toBe(30);
    expect(again.ctl.values()['frameRateCap']).toBe(30);
  });
});
