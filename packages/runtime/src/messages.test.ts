/**
 * `ctx.messages`: named messages between scripts.
 *
 * A message sent in a step is seen in the next step (like signals), by every
 * script or only by the scripts on its target entity, in send order, with its
 * value and sender; bad names/values and the per-step limit are refused
 * (`false`, never a throw); a new run clears them.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_MESSAGES_PER_STEP,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type BehaviorLifecycle,
  type BehaviorMessages,
  type Runtime,
} from './index';

const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, 0], ...T });
const BOX = { size: [1, 1, 1], material: { color: '#ffffff' } };

interface Ctx {
  stepIndex: number;
  phase: string;
  entityId: string;
  messages: BehaviorMessages;
  lifecycle: BehaviorLifecycle;
}

function artifact(behaviorId: string, step: (ctx: Ctx) => void): never {
  return {
    behaviorId,
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { step: (_s: unknown, ctx: Ctx) => step(ctx) } },
  } as never;
}


function port(): unknown {
  const zero = { x: 0, y: 0 };
  return {
    stageCharacterMove() {},
    step: () => ({ requested: { ...zero }, applied: { ...zero }, position: { x: 0, y: 0 }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false }),
    reset() {},
    clearCharacterMotion() {},
    placeCharacter: () => ({ ok: true, supportNormal: { x: 0, y: 1 } }),
    characterClearance: () => ({ ok: true, supportNormal: { x: 0, y: 1 } }),
    addStaticColliders() {},
    removeStaticColliders() {},
    setKinematicPositions() {},
    diagnostics: () => ({}),
    dispose() {},
  };
}

/** One script (`step`) on the boxes `ids`; ticks the running game. */
function harness(step: (ctx: Ctx) => void, ids: string[]) {
  const spec = createBehaviorModuleSpec({ declaration: { properties: [] }, artifact: artifact('talker', step) });
  const specs = [spec];
  const registry = createSimulationRegistry();
  for (const s of specs) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'messages@r1',
      projectId: 'messages',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'player-0001', components: { transform: at(0, 0) } },
          { id: 'spawn-0001', components: { transform: at(0, 0), playerSpawn: {} } },
          ...ids.map((id, i) => ({ id, components: { transform: at(5 + i, -5), box: BOX, behavior: { behaviorId: 'talker', values: {} } } })),
        ],
      },
    },
    registry,
    modules: specs.map((s) => s.id),
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: port() as never,
    settings: {},
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    }
  };
  return { rt, tick };
}

describe('ctx.messages', () => {
  it('a message is seen in the next step, by everyone or by its target only, in send order with value and sender', () => {
    const seen: string[] = [];
    let sendAt = -1;
    const h = harness(
      (ctx) => {
        if (ctx.phase !== 'intent') return;
        if (sendAt < 0) sendAt = ctx.stepIndex + 2;
        if (ctx.stepIndex === sendAt && ctx.entityId === 'box-a') {
          expect(ctx.messages.send('ping', 3)).toBe(true);
          expect(ctx.messages.send('ping', 'two')).toBe(true);
          expect(ctx.messages.send('hello', true, 'box-b')).toBe(true);
          expect(ctx.messages.send('plain')).toBe(true);
        }
        for (const name of ['ping', 'hello', 'plain']) {
          for (const m of ctx.messages.received(name)) seen.push(`${ctx.stepIndex - sendAt}:${ctx.entityId}<-${m.from}:${m.name}=${JSON.stringify(m.value)}@${m.stepIndex - sendAt}`);
        }
      },
      ['box-a', 'box-b', 'box-c'],
    );
    h.tick(6);
    expect(seen).toEqual([
      '1:box-a<-box-a:ping=3@0',
      '1:box-a<-box-a:ping="two"@0',
      '1:box-a<-box-a:plain=null@0',
      '1:box-b<-box-a:ping=3@0',
      '1:box-b<-box-a:ping="two"@0',
      '1:box-b<-box-a:hello=true@0',
      '1:box-b<-box-a:plain=null@0',
      '1:box-c<-box-a:ping=3@0',
      '1:box-c<-box-a:ping="two"@0',
      '1:box-c<-box-a:plain=null@0',
    ]);
  });

  it(`bad names and values are refused; at most ${MAX_MESSAGES_PER_STEP} per step (the refusals are a diagnostics warning); a new run clears them`, () => {
    const results: boolean[] = [];
    let lastStep = 0;
    let receivedAfterReplay = 0;
    let replayed = false;
    let burstStep = -1;
    const h = harness(
      (ctx) => {
        if (ctx.phase !== 'intent') return;
        lastStep = ctx.stepIndex;
        if (replayed) receivedAfterReplay += ctx.messages.received('burst').length;
        if (results.length === 0) {
          for (const [n, v, t] of [['', 1], ['a b', 1], ['ok', Number.NaN], ['ok', 'x'.repeat(257)], ['ok', { no: 1 }], ['ok', 1, 7]] as [string, unknown, unknown][]) {
            results.push(ctx.messages.send(n, v as number, t as string));
          }
          let accepted = 0;
          burstStep = ctx.stepIndex;
          for (let i = 0; i < MAX_MESSAGES_PER_STEP + 5; i++) if (ctx.messages.send('burst', i)) accepted += 1;
          results.push(accepted === MAX_MESSAGES_PER_STEP);
          // The engine restart (a new run) applies at the next step boundary.
          expect(ctx.lifecycle.restart()).toBe(true);
          replayed = true;
        }
      },
      ['box-a'],
    );
    h.tick(1);
    expect(results).toEqual([false, false, false, false, false, false, true]);
    // The burst was sent in the last step of the run; the restarted run starts without it.
    expect(lastStep).toBeGreaterThan(0);
    h.tick(3);
    expect(receivedAfterReplay).toBe(0);
    // The five over the limit are counted and named in the diagnostics (a restart keeps them: they are the play's).
    const d = h.rt.getDiagnostics();
    if (!d.ok) throw new Error('no diagnostics');
    expect(d.diagnostics.messageQueue).toMatchObject({ refused: 5, firstRefusedStep: burstStep, lastRefusedStep: burstStep, perStepLimit: MAX_MESSAGES_PER_STEP });
    expect(d.diagnostics.messageQueue!.warning).toContain(`more than ${MAX_MESSAGES_PER_STEP} sent in one step`);
  });

  it('no refused send: the diagnostics have no message-queue block', () => {
    const h = harness((ctx) => {
      if (ctx.phase === 'intent') ctx.messages.send('ping', 1);
    }, ['box-a']);
    h.tick(5);
    const d = h.rt.getDiagnostics();
    expect(d.ok && d.diagnostics.messageQueue).toBe(undefined);
  });
});
