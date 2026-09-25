/**
 * Phase 9.13: Sprout's two demo levels, played start to finish headlessly —
 * the real game host, platformer, Rapier and scene loading over the Sprout
 * project's saved scenes (~/projects/sprout/thirdlight; skipped when that
 * repo is absent) — by a small bot that sees what a player sees: the ground
 * and platforms ahead (physics raycasts), boars ahead. It goes through the
 * title screen, both levels and their "level complete" screens to the end
 * screen, and reports each level's time and deaths.
 *
 * Phase 22.0: the play-through runs in both threading modes — the simulation
 * in the page and in the simulation worker (a Node worker thread with the
 * same game-host worker core as the browser bundles; the bot's rays are
 * asked of the worker, one batch per decision).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createBehaviorCompiler } from '@thirdlight/behavior-build';
import { capsuleHalfTotal, playerCapsuleOf } from '@thirdlight/runtime';

import { MODES, startHarness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DIR = join(homedir(), 'projects', 'sprout', 'thirdlight');
const HZ = 120;
const DT = 1 / HZ;

const sceneOf = (id: string): Any[] => JSON.parse(readFileSync(join(DIR, 'scenes', `${id}.json`), 'utf8')).scene.entities;

/**
 * Phase 14.9: the project's published scripts, compiled from their stored
 * sources by the same pinned compiler the backend uses and linked the way the
 * export links them (a boar drops a coin through `ctx.spawn`): manifest rows
 * and each compiled module as a data: URL (imported by whichever thread runs
 * the simulation).
 */
async function projectBehaviors(content: Any): Promise<{ behaviors: { row: Any; url: string }[]; enginePins: Any[] }> {
  const compiler = createBehaviorCompiler();
  const behaviors: { row: Any; url: string }[] = [];
  let enginePins: Any[] = [];
  for (const b of content.behaviors ?? []) {
    if (b.source === null || b.source === undefined) continue;
    const containerBytes = new Uint8Array(readFileSync(join(DIR, 'sources', 'sha256', b.source.sourceDigest)));
    const out: Any = await compiler.compile({ behaviorId: b.behaviorId, declaration: b.declaration, containerBytes, pinnedModules: compiler.pinnedModules });
    if (!out.ok) throw new Error(`compile ${b.behaviorId}: ${JSON.stringify(out).slice(0, 400)}`);
    expect(out.outputDigest).toBe(b.source.outputDigest);
    enginePins = out.manifest.enginePins;
    behaviors.push({
      row: { behaviorId: b.behaviorId, sourceDigest: b.source.sourceDigest, manifestDigest: out.manifestDigest, outputDigest: out.outputDigest, declaration: b.declaration, ownedTransforms: out.manifest.ownedTransforms, requiredModules: out.manifest.requiredModules, path: b.behaviorId },
      url: `data:text/javascript;base64,${Buffer.from(out.outputBytes).toString('base64')}`,
    });
  }
  return { behaviors, enginePins };
}

async function playThrough(mode: Mode): Promise<void> {
  const content = JSON.parse(readFileSync(join(DIR, 'content.json'), 'utf8')).content;
  const start: string[] = content.startScenes;
  const scenes: Record<string, Any[]> = Object.fromEntries(content.scenes.map((s: Any) => [s.sceneId, sceneOf(s.sceneId)]));
  const startEntities = start.flatMap((id) => scenes[id]!);
  const byId = new Map<string, Any>(Object.values(scenes).flat().map((e: Any) => [e.id, e]));
  const worldPos = (e: Any): [number, number] => {
    let x = e.components.transform.position[0];
    let y = e.components.transform.position[1];
    for (let p = e.parentId; p !== undefined && p !== null; p = byId.get(p)?.parentId) {
      const t = byId.get(p)?.components.transform.position;
      if (t) {
        x += t[0];
        y += t[1];
      }
    }
    return [x, y];
  };
  const statics = startEntities
    .filter((e) => e.components.collider !== undefined)
    .map((e) => {
      const [x, y] = worldPos(e);
      return { entityId: e.id, shape: e.components.collider.shape, position: { x, y }, rotationZ: 0, ...(e.components.mover ? { kinematic: true } : {}), ...(e.components.collider.oneWay ? { oneWay: true } : {}) };
    });
  const settings = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, ...content.settings };
  const player = byId.get(content.game.playerId);
  const [px0, py0] = worldPos(player);
  // Phase 14.9: the player's own capsule (Sprout's is fitted to his model), as the hosts pass it.
  const capsule = playerCapsuleOf(player.components.controller);
  const physics = {
    character: { x: px0, y: py0, radius: capsule.radius, halfHeight: capsule.halfHeight, offset: capsule.offset },
    statics,
    solver: { hz: HZ, gravityY: settings.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180, minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180, autostep: false },
  };

  // The bot's input: decided from the last committed state (one step behind, like a player).
  let frame = { moveX: 0, jump: 'none' as string };
  const ui: Any = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
  const { behaviors, enginePins } = await projectBehaviors(content);
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: 'sprout@r1',
      projectId: 'sprout',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: start[0], revision: 1, entities: startEntities },
      scenes: content.scenes.map((s: Any) => ({ sceneId: s.sceneId, start: start.includes(s.sceneId), ...(start.includes(s.sceneId) ? { entityIds: scenes[s.sceneId]!.map((e: Any) => e.id) } : {}) })),
      game: content.game,
      // Phase 14.9: animators (a stomped boar's `defeated`), prefabs (its dropped coin).
      ...(content.animators !== undefined ? { animators: content.animators } : {}),
      ...(content.prefabs !== undefined ? { prefabs: content.prefabs } : {}),
    },
    settings,
    physics,
    behaviors,
    enginePins,
    input: {
      sample: (stepIndex: number) => ({ stepIndex, ...frame }),
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      markConfirmConsumed: () => undefined,
      sampleUi: () => {
        const out = { ...ui };
        for (const k of Object.keys(ui)) ui[k] = false;
        return out;
      },
      dispose: () => undefined,
    },
    loadScene: async (id: string) => scenes[id] as Any,
    host: {
      audio: { registerCue: () => ({ ok: true }), submit: () => ({ ok: true }), unlock: async () => ({ state: 'blocked' }), setMuted: () => ({}), setHidden: () => ({}), status: () => ({ state: 'blocked', reason: 'autoplay_denied' }), dispose: () => ({ ok: true }), liveVoices: () => 0 },
      buildId: 'sprout-test',
      flow: content.flow,
    },
  });
  const host = h.host;
  const rt: Any = h.rt;
  const enemies = new Set([...byId.values()].filter((e) => e.components.enemy !== undefined).map((e) => e.id));

  // --- the bot -----------------------------------------------------------------
  let jumpHold = 0;
  let airborneSince = 0;
  // The feet: the capsule's bottom below the player's origin.
  const FEET = capsuleHalfTotal(capsule) - capsule.offset.y;
  const down = (x: number, y: number, d: number) => ({ origin: { x, y }, dir: { x: 0, y: -1 }, maxDistance: d });
  const decide = async (view: Any): Promise<void> => {
    const t = rt.getInterpolatedState().state.transforms;
    const me = t.find((x: Any) => x.id === content.game.playerId);
    if (me === undefined) return;
    const x = me.position[0];
    const feet = me.position[1] - FEET;
    if (jumpHold > 0) {
      jumpHold -= 1;
      frame = { moveX: 1, jump: 'held' };
      return;
    }
    if (!view.playerMotion.grounded) {
      airborneSince += 1;
      frame = { moveX: 1, jump: 'none' };
      return;
    }
    airborneSince = 0;
    // Every ray the decision may look at, asked in one batch (the same rays, the same order).
    const gaps: number[] = [];
    for (let d = 1.8; d <= 4.4; d += 0.2) gaps.push(d);
    const drops: number[] = [];
    for (let d = 0.8; d <= 2.6; d += 0.3) drops.push(d);
    const hits = await h.access.raycast([down(x + 0.75, feet + 0.4, 1.0), ...gaps.map((d) => down(x + d, feet + 2.4, 4.2)), ...drops.map((d) => down(x + d, feet + 0.2, 6.5))]);
    const supportAhead = hits[0] !== null;
    const hidden: ReadonlySet<string> = rt.hiddenEntities();
    const boar = t.some((e: Any) => enemies.has(e.id) && !hidden.has(e.id) && e.position[0] - x > 0.3 && e.position[0] - x < 2.3 && Math.abs(e.position[1] - feet) < 1.2);
    const press = (): void => {
      frame = { moveX: 1, jump: 'pressed' };
      jumpHold = 26;
    };
    if (boar) return press();
    if (supportAhead) {
      frame = { moveX: 1, jump: 'none' };
      return;
    }
    // A gap ahead: jump to a landing at about this height or higher (within the jump's reach) ...
    for (let i = 0; i < gaps.length; i += 1) {
      const hit = hits[1 + i];
      if (hit !== null && hit !== undefined && feet + 2.4 - hit.distance >= feet - 1.2) return press();
    }
    // ... or walk off to a lower landing close ahead ...
    for (let i = 0; i < drops.length; i += 1) {
      if (hits[1 + gaps.length + i] !== null) {
        frame = { moveX: 1, jump: 'none' };
        return;
      }
    }
    // ... or wait at the edge for a platform.
    frame = { moveX: 0, jump: 'none' };
  };

  // --- the run -------------------------------------------------------------------
  let now = 0;
  const results: { level: string; seconds: number; deaths: number; counters: Record<string, number>; spawned: number; spawnedTaken: number; score: unknown }[] = [];
  let spawnedSeen = new Set<string>();
  let spawnedTaken = new Set<string>();
  let lastCounters: Record<string, number> = {};
  let levelStart = 0;
  let lastDeaths = 0;
  let screen = '';
  let maxSteps = HZ * 60 * 6; // six minutes of game time at most
  ui.submit = true; // New game from the title
  try {
    while (maxSteps-- > 0) {
      now += DT;
      try {
        await h.tick(now);
      } catch (e) {
        const me = rt.getInterpolatedState().state?.transforms.find((x: Any) => x.id === content.game.playerId);
        throw new Error(`${e instanceof Error ? e.message : String(e)} failure=${JSON.stringify(rt.getGameView().view?.failure)} errors=${JSON.stringify(rt.getDiagnostics().diagnostics?.errors)?.slice(-700)} player=${JSON.stringify(me?.position)} screen=${screen} results=${JSON.stringify(results)}`);
      }
      if (maxSteps % 30 === 0) await new Promise((res) => setTimeout(res, 0)); // scene loads resolve
      const obs = (host.observe() as Any).observation;
      const view = rt.getGameView().view;
      const flow = obs.flow;
      if (flow.screen !== screen) {
        if (flow.screen === 'playing') {
          levelStart = view.simTime;
          spawnedSeen = new Set();
          spawnedTaken = new Set();
        }
        if (flow.screen === 'levelComplete') results.push({ level: flow.levelId, seconds: Math.round((view.simTime - levelStart) * 10) / 10, deaths: lastDeaths, counters: lastCounters, spawned: spawnedSeen.size, spawnedTaken: spawnedTaken.size, score: flow.score });
        if (flow.screen === 'levelComplete' || flow.screen === 'gameOver') ui.submit = true;
        screen = flow.screen;
        if (screen === 'finished') break;
      }
      if (process.env['TL_BOT_TRACE'] !== undefined && screen === 'playing' && maxSteps % 30 === 0) {
        const tr = rt.getInterpolatedState().state.transforms;
        const me = tr.find((x: Any) => x.id === content.game.playerId);
        if (me !== undefined && me.position[0] > 48) {
          const gates = [...byId.values()].filter((e) => e.name === 'Gate').map((g) => tr.find((x: Any) => x.id === g.id)?.position?.map((v: number) => v.toFixed(2)).join(','));
          console.log('T', view.stepIndex, me.position.map((v: number) => v.toFixed(2)).join(','), 'grounded', view.playerMotion.grounded, 'gates', gates.join(' | '), JSON.stringify(frame), 'deaths', view.deathCount);
        }
      }
      if (screen === 'playing') {
        lastDeaths = view.deathCount;
        lastCounters = { ...rt.gameCounters().counters };
        for (const e of rt.sceneSet().spawned) spawnedSeen.add(e.id);
        for (const id of rt.hiddenEntities()) if (spawnedSeen.has(id)) spawnedTaken.add(id);
        await decide(view);
      } else frame = { moveX: 0, jump: 'none' };
    }
    process.stderr.write(`Sprout meadows play-through (${mode}): ${JSON.stringify(results)}\n`);
    const endAt = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === content.game.playerId)?.position;
    console.log('end state:', screen, JSON.stringify(endAt), 'deaths', rt.getGameView().view.deathCount, 'frame', JSON.stringify(frame));
    expect(screen).toBe('finished');
    expect(results.map((r) => r.level)).toEqual(['meadow-1', 'meadow-2']);
    // Phase 14.9: every boar the bot stomped dropped a coin (Sprout's script, ctx.spawn).
    for (const r of results) expect(r.spawned).toBe(r.counters['defeated'] ?? 0);
  } finally {
    await h.dispose();
  }
}

describe.skipIf(!existsSync(join(DIR, 'content.json')))('Sprout meadows (headless play-through)', () => {
  for (const mode of MODES) {
    it(`both levels can be played from the title screen to the end (threading: ${mode})`, () => playThrough(mode), 240_000);
  }
});
