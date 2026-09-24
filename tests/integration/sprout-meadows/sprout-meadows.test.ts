/**
 * Phase 9.13: Sprout's two demo levels, played start to finish headlessly —
 * the real game host, platformer, Rapier and scene loading over the Sprout
 * project's saved scenes (~/projects/sprout/thirdlight; skipped when that
 * repo is absent) — by a small bot that sees what a player sees: the ground
 * and platforms ahead (physics raycasts), boars ahead. It goes through the
 * title screen, both levels and their "level complete" screens to the end
 * screen, and reports each level's time and deaths.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DIR = join(homedir(), 'projects', 'sprout', 'thirdlight');
const HZ = 120;
const DT = 1 / HZ;

class FakeNode {
  textContent = '';
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const sceneOf = (id: string): Any[] => JSON.parse(readFileSync(join(DIR, 'scenes', `${id}.json`), 'utf8')).scene.entities;

describe.skipIf(!existsSync(join(DIR, 'content.json')))('Sprout meadows (headless play-through)', () => {
  it('both levels can be played from the title screen to the end', async () => {
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
    const physics = await createPhysicsPort({
      character: { x: px0, y: py0 },
      statics,
      solver: { hz: HZ, gravityY: settings.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180, minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180, autostep: false },
    } as Any);
    if (!physics.ok) throw new Error(JSON.stringify(physics.error));
    const port: Any = physics.port;
    if (process.env['TL_BOT_TRACE'] !== undefined) {
      const orig = port.step.bind(port);
      let n = 0;
      port.step = () => {
        const r = orig();
        if (r.position.x > 54 && r.position.y > 5 && n++ < 40) console.log('P', JSON.stringify({ req: r.requested, app: r.applied, pos: r.position, g: r.grounded, n: r.supportNormal, c: r.contacts, s: r.kinematicSlack }));
        return r;
      };
    }

    // The bot's input: decided from the last committed state (one step behind, like a player).
    let frame = { moveX: 0, jump: 'none' as string };
    const ui: Any = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
    const host = createGameHost({
      snapshot: {
        snapshotId: 'sprout@r1',
        projectId: 'sprout',
        revision: 1,
        scene: { schemaVersion: 4, sceneId: start[0], revision: 1, entities: startEntities },
        scenes: content.scenes.map((s: Any) => ({ sceneId: s.sceneId, start: start.includes(s.sceneId), ...(start.includes(s.sceneId) ? { entityIds: scenes[s.sceneId]!.map((e: Any) => e.id) } : {}) })),
        game: content.game,
      },
      settings,
      physics: port,
      adapter: () => null,
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
      audio: { registerCue: () => ({ ok: true }), submit: () => ({ ok: true }), unlock: async () => ({ state: 'blocked' }), setMuted: () => ({}), setHidden: () => ({}), status: () => ({ state: 'blocked', reason: 'autoplay_denied' }), dispose: () => ({ ok: true }), liveVoices: () => 0 },
      readArtifact: async () => new ArrayBuffer(0),
      container: new FakeNode(),
      buildId: 'sprout-test',
      document: { createElement: () => new FakeNode() },
      loadScene: async (id: string) => scenes[id] as Any,
      flow: content.flow,
    } as Any);
    const mounted = host.mount();
    if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
    const rt: Any = host.runtime;
    const enemies = new Set([...byId.values()].filter((e) => e.components.enemy !== undefined).map((e) => e.id));

    // --- the bot -----------------------------------------------------------------
    let jumpHold = 0;
    let airborneSince = 0;
    const FEET = 0.9;
    const ray = (x: number, y: number, dx: number, dy: number, d: number): { distance: number } | null => port.raycast({ x, y }, { x: dx, y: dy }, d);
    const decide = (view: Any): void => {
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
      const supportAhead = ray(x + 0.75, feet + 0.4, 0, -1, 1.0) !== null;
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
      for (let d = 1.8; d <= 4.4; d += 0.2) {
        const hit = ray(x + d, feet + 2.4, 0, -1, 4.2);
        if (hit !== null && feet + 2.4 - hit.distance >= feet - 1.2) return press();
      }
      // ... or walk off to a lower landing close ahead ...
      for (let d = 0.8; d <= 2.6; d += 0.3) {
        const hit = ray(x + d, feet + 0.2, 0, -1, 6.5);
        if (hit !== null) {
          frame = { moveX: 1, jump: 'none' };
          return;
        }
      }
      // ... or wait at the edge for a platform.
      frame = { moveX: 0, jump: 'none' };
    };

    // --- the run -------------------------------------------------------------------
    let now = 0;
    const results: { level: string; seconds: number; deaths: number }[] = [];
    let levelStart = 0;
    let lastDeaths = 0;
    let screen = '';
    let maxSteps = HZ * 60 * 6; // six minutes of game time at most
    ui.submit = true; // New game from the title
    while (maxSteps-- > 0) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) {
        const me = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === content.game.playerId);
        throw new Error(`${JSON.stringify(r.error)} failure=${JSON.stringify(rt.getGameView().view.failure)} errors=${JSON.stringify(rt.getDiagnostics().diagnostics?.errors)?.slice(-700)} player=${JSON.stringify(me?.position)} screen=${screen} results=${JSON.stringify(results)}`);
      }
      if (maxSteps % 30 === 0) await new Promise((res) => setTimeout(res, 0)); // scene loads resolve
      const obs = (host.observe() as Any).observation;
      const view = rt.getGameView().view;
      const flow = obs.flow;
      if (flow.screen !== screen) {
        if (flow.screen === 'playing') levelStart = view.simTime;
        if (flow.screen === 'levelComplete') results.push({ level: flow.levelId, seconds: Math.round((view.simTime - levelStart) * 10) / 10, deaths: lastDeaths });
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
        decide(view);
      } else frame = { moveX: 0, jump: 'none' };
    }
    process.stderr.write(`Sprout meadows play-through: ${JSON.stringify(results)}\n`);
    const endAt = rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === content.game.playerId)?.position;
    console.log('end state:', screen, JSON.stringify(endAt), 'deaths', rt.getGameView().view.deathCount, 'frame', JSON.stringify(frame));
    expect(screen).toBe('finished');
    expect(results.map((r) => r.level)).toEqual(['meadow-1', 'meadow-2']);
  }, 180_000);
});
