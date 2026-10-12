/**
 * The Scene view's tool router: which tool a press, move, release and Esc
 * reach, and what the view's orbiting and pointer capture do meanwhile.
 */
import { describe, expect, it } from 'vitest';

import { ToolRouter, type SceneTool, type ToolPress, type ToolRelease } from './tool-input';

interface Fake extends SceneTool {
  calls: string[];
}

function tool(name: string, o: { press?: ToolPress; move?: boolean; release?: ToolRelease; click?: ToolRelease; inFlight?: boolean; armed?: boolean } = {}): Fake {
  const calls: string[] = [];
  return {
    name,
    calls,
    armed: () => o.armed === true,
    pointerDown: () => (calls.push('down'), o.press ?? null),
    pointerMove: () => (calls.push('move'), o.move === true),
    pointerUp: () => (calls.push('up'), o.release ?? null),
    ...(o.click !== undefined ? { click: () => (calls.push('click'), o.click ?? null) } : {}),
    leave: () => void calls.push('leave'),
    cancel: () => (calls.push('cancel'), o.inFlight === true),
  };
}

function rig(tools: SceneTool[], esc?: string[]) {
  const state = { orbit: true, captured: [] as number[] };
  const canvas = { setPointerCapture: (id: number) => void state.captured.push(id) } as unknown as HTMLCanvasElement;
  const router = new ToolRouter({ canvas: () => canvas, setOrbit: (on) => (state.orbit = on) }, tools, esc);
  return { router, state };
}

function event(): PointerEvent & { stopped: boolean } {
  const e = { pointerId: 7, stopped: false, stopImmediatePropagation: () => (e.stopped = true) };
  return e as unknown as PointerEvent & { stopped: boolean };
}

describe('tool router', () => {
  it('a press goes to the first tool that takes it; capturing stops orbiting and captures the pointer', () => {
    const a = tool('a');
    const b = tool('b', { press: 'capture' });
    const c = tool('c', { press: 'capture' });
    const { router, state } = rig([a, b, c]);
    const e = event();
    expect(router.pointerDown(e)).toBe(true);
    expect([a.calls, b.calls, c.calls]).toEqual([['down'], ['down'], []]);
    expect(e.stopped).toBe(true);
    expect(state).toEqual({ orbit: false, captured: [7] });
  });

  it('a consumed press is taken without capturing; an untaken press reaches the view', () => {
    const { router, state } = rig([tool('a', { press: 'consume' })]);
    const e = event();
    expect(router.pointerDown(e)).toBe(true);
    expect(e.stopped).toBe(true);
    expect(state).toEqual({ orbit: true, captured: [] });
    const free = rig([tool('a')]);
    const f = event();
    expect(free.router.pointerDown(f)).toBe(false);
    expect(f.stopped).toBe(false);
  });

  it('a release ends a gesture before any tool acts on a plain click', () => {
    const decal = tool('decal', { click: 'pass' });
    const handles = tool('handles', { release: 'stop' });
    const { router, state } = rig([decal, handles]);
    state.orbit = false;
    const e = event();
    expect(router.pointerUp(e)).toBe(true);
    expect(decal.calls).toEqual(['up']);
    expect(e.stopped).toBe(true);
    expect(state.orbit).toBe(true);
  });

  it('a click a tool acts on lets the orbit controls see the release', () => {
    const decal = tool('decal', { click: 'pass' });
    const { router, state } = rig([tool('handles'), decal]);
    const e = event();
    expect(router.pointerUp(e)).toBe(true);
    expect(decal.calls).toEqual(['up', 'click']);
    expect(e.stopped).toBe(false);
    expect(state.orbit).toBe(true);
    // Nobody's: the view picks.
    expect(rig([tool('a', { click: null })]).router.pointerUp(event())).toBe(false);
  });

  it('a move a tool owns stops at it', () => {
    const a = tool('a', { move: true });
    const b = tool('b', { move: true });
    const { router } = rig([a, b]);
    const e = event();
    expect(router.pointerMove(e)).toBe(true);
    expect(b.calls).toEqual([]);
    expect(e.stopped).toBe(true);
  });

  it('Esc asks in its own order, then the rest in priority order, and orbiting comes back', () => {
    const paint = tool('paint', { inFlight: true });
    const block = tool('block', { inFlight: true });
    const brush = tool('brush');
    const { router, state } = rig([paint, block, brush], ['block']);
    state.orbit = false;
    expect(router.cancel()).toBe(true);
    expect([block.calls, paint.calls]).toEqual([['cancel'], []]);
    expect(state.orbit).toBe(true);
    const idle = rig([tool('a'), tool('b')]);
    expect(idle.router.cancel()).toBe(false);
  });

  it('armed: any tool armed for the selection; keys reach only armed tools', () => {
    const a = tool('a');
    const b: SceneTool = { ...tool('b', { armed: true }), key: () => true };
    const c: SceneTool = { ...tool('c'), key: () => true };
    expect(rig([a]).router.anyArmed(null)).toBe(false);
    const { router } = rig([a, c, b]);
    expect(router.anyArmed('x')).toBe(true);
    expect(router.key({} as KeyboardEvent, 'x')).toBe(true);
    expect(rig([a, c]).router.key({} as KeyboardEvent, 'x')).toBe(false);
    // An edit mode names the tools its keys reach: an armed tool it does not name takes none.
    expect(router.key({} as KeyboardEvent, 'x', ['b'])).toBe(true);
    expect(router.key({} as KeyboardEvent, 'x', ['a', 'c'])).toBe(false);
  });
});
