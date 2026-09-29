/**
 * Scene loading through the production composition (the real game host and
 * Rapier, both threading modes): a scene transition's loading state as a
 * project UI document reads it (`$flow.scenes`), the host's fade over the
 * view, and the page's preloader answering the load only once the scene is
 * prepared — while it waits, the old scene stays loaded (never an empty
 * world), then the new one arrives and the old one leaves in one step.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createScenePreloader } from '@thirdlight/game-host';

import { FakeNode, MODES, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const HUD = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'state', text: 'loading={$flow.scenes.loading} phase={$flow.scenes.transition.phase}' } };

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

function texts(n: Any, out: string[] = []): string[] {
  if (typeof n?.textContent === 'string' && n.textContent !== '') out.push(n.textContent);
  for (const c of n?.children ?? []) texts(c, out);
  return out;
}
function hudText(n: Any): string | null {
  if (n?.attrs?.['data-tl-ui-source'] === 'hud') return texts(n).join('');
  for (const c of n?.children ?? []) {
    const t = hudText(c);
    if (t !== null) return t;
  }
  return null;
}
/** The fade node's opacity (the host's overlay; absent: 0). */
function fadeOf(n: Any): number {
  if (n?.attrs?.['data-tl-fade'] !== undefined) return Number(n.attrs['data-tl-fade']);
  for (const c of n?.children ?? []) {
    const v = fadeOf(c);
    if (v > 0) return v;
  }
  return 0;
}

async function run(mode: Mode): Promise<Record<string, Any>> {
  const main = [
    { id: 'cam-main', components: { transform: T([4, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: {} } },
    { id: 'floor-a', components: { transform: T([3, -0.5, 0]), box: { size: [28, 1, 4], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 14, hy: 0.5 } } } },
  ];
  const side = [{ id: 'wall-a', components: { transform: T([0, 3, -4]), box: { size: [20, 10, 1], material: { color: '#aa3333' } } } }, { id: 'door-a', components: { transform: T([0, 1, 0]), trigger: { size: [3, 3], signal: 'door', sceneTransition: { scene: 'scene-two', unload: ['scene-side'], fade: 0.25, fadeColor: '#102030' } } } }];
  const two = [{ id: 'floor-b', components: { transform: T([45, -0.5, 0]), box: { size: [12, 1, 4], material: { color: '#888888' } } } }];
  // The page's read of scene-two waits for the test (a slow disk, a large scene).
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const reads: string[] = [];
  const scenes = createScenePreloader({
    read: async (id: string) => {
      reads.push(id);
      if (id === 'scene-side') return side as Any;
      await gate;
      return two as Any;
    },
  });
  const container = new FakeNode();
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: 'loading@r1',
      projectId: 'loading',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-side', start: false },
        { sceneId: 'scene-two', start: false },
      ],
      uiDocuments: [{ uiDocumentId: 'hud', layer: 0, modal: false }],
    },
    settings: { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 },
    physics: { character: { x: 0, y: 0.91 }, statics: [{ entityId: 'floor-a', shape: { type: 'box', hx: 14, hy: 0.5 }, position: { x: 3, y: -0.5 }, rotationZ: 0 }], solver: { hz: 120, gravityY: -20 }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } },
    loadScene: scenes.load,
    host: { container, ui: { documents: [HUD] }, shell: { hud: ['hud'] }, scenes },
  });
  live.push(h);
  let now = 0;
  const frames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      now += DT;
      await h.tick(now);
      if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  };
  const obs = (): Any => (h.host as Any).observe().observation;
  const loaded = (): string[] => obs().scenes?.loaded ?? [];
  const out: Record<string, Any> = { history: [] as string[][] };
  const watch = (): void => {
    const l = loaded();
    const last = out.history[out.history.length - 1];
    if (last === undefined || last.join() !== l.join()) out.history.push(l);
  };
  await frames(10);
  // The side scene (a plain load): the character stands in its door, which sends it on to scene-two.
  expect(h.host.scene('load', 'scene-side').ok).toBe(true);
  for (let i = 0; i < 200 && !reads.includes('scene-two'); i += 1) {
    await frames(1);
    watch();
  }
  // Waiting for scene-two (its read held): the side scene stays; the HUD and the observation say it loads; the view fades out.
  for (let i = 0; i < 60; i += 1) {
    await frames(1);
    watch();
  }
  out.waiting = { loaded: loaded(), transition: obs().scenes?.transition, hud: hudText(container), fade: fadeOf(container) };
  release!();
  for (let i = 0; i < 400 && !loaded().includes('scene-two'); i += 1) {
    await frames(1);
    watch();
  }
  await frames(5);
  watch();
  out.arrived = { loaded: loaded(), transition: obs().scenes?.transition ?? null, hud: hudText(container) };
  // No adapter here: the swap counts as drawn at once and the view fades back in over 0.25 s.
  await new Promise((r) => setTimeout(r, 300));
  await frames(2);
  out.after = { fade: fadeOf(container) };
  const d = (h.rt as Any).getDiagnostics();
  out.errors = d.ok ? d.diagnostics.errors : d;
  scenes.dispose();
  return out;
}

describe('scene loading state (phase 25.24e)', () => {
  it.each(MODES)('a transition waits for its scene with the old one in place; $flow.scenes and the fade show it (threading: %s)', async (mode) => {
    const o = await run(mode);
    expect(o.errors).toEqual([]);
    expect(o.waiting.loaded).toEqual(['scene-main', 'scene-side']);
    expect(o.waiting.transition).toEqual(expect.objectContaining({ scene: 'scene-two', phase: 'loading', fade: 1, color: '#102030' }));
    expect(o.waiting.hud.endsWith('loading=true phase=loading'), o.waiting.hud).toBe(true);
    expect(o.waiting.fade).toBe(1);
    expect(o.arrived.loaded).toEqual(['scene-main', 'scene-two']);
    expect(o.arrived.transition).toBeNull();
    expect(o.arrived.hud.endsWith('loading=false phase='), o.arrived.hud).toBe(true);
    // Never a world without the side scene or scene-two.
    expect(o.history).toEqual([['scene-main'], ['scene-main', 'scene-side'], ['scene-main', 'scene-two']]);
    expect(o.after.fade).toBe(0);
  });
});
