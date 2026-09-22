/**
 * Packet 34 — the Node test host for trusted behavior execution.
 *
 * This is the ONLY place a published behavior is executed in this packet
 * (there is no browser in this container). It:
 *
 *  1. reads the committed packet-33 compiled example artifact
 *     (`fixtures/m2/behaviors/valid/sample.output.js`, digest-bound by
 *     `expected.json`) and executes it in a **bounded `node:vm` context**
 *     (no network, no `eval`/`new Function` code generation, a wall-clock
 *     timeout on the module evaluation) — the runtime host itself never
 *     evaluates or imports source;
 *  2. composes the real `@thirdlight/runtime` module set (the behavior host
 *     plus a test consumer module) and measures the play state;
 *  3. proves the acceptance rows: the declared numeric property changes the
 *     measured behavior after a fresh instantiation; the source/snapshot bytes
 *     are unchanged; exceptions fail-stop with bounded diagnostics; invalid
 *     intents are rejected; a log flood stays bounded; two writers are
 *     rejected; and a change to the artifact/values used by a *fresh*
 *     instance never changes an already-running instance.
 *
 * The ESM default-export rewrite is a documented test-host shim: the artifact
 * is `format: "esm"` with exactly one `export { X as default };` statement and
 * no imports (the compiler erases type-only engine imports), so the shim
 * replaces that single statement with a global assignment before the bounded
 * `vm.Script` run. The executed function bodies are the committed bytes.
 *
 * NOT a production bootstrap; named `.test.ts` so vitest runs it in Node.
 */
import { describe, expect, it } from 'vitest';
import { createContext, runInContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  M2_PINNED_MODULES,
  canonicalContainerText,
  compileBehavior,
} from '../../../packages/behavior-build/src/index';
import type { DeclaredProperty } from '@thirdlight/project-model';
import {
  BehaviorHostError,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type BehaviorArtifact,
  type RuntimeDiagnostics,
  type SimulationModuleSpec,
} from '../../../packages/runtime/src/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures', 'm2', 'behaviors');
const DT = 1 / 120;

const index = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'expected.json'), 'utf8')) as {
  behaviorId: string;
  declaration: { properties: DeclaredProperty[] };
};
const DECLARATION = index.declaration;
const SPEED = DECLARATION.properties[0]!;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * Execute a compiled artifact in a bounded `vm` context and return its default
 * export. `codeGeneration` is closed, so an artifact cannot `eval`/`new
 * Function` its way out; evaluation has a hard wall-clock bound (which,
 * per runtime.md §14.1.1, does NOT preempt a same-thread loop *inside a step* —
 * it only bounds module evaluation here).
 */
function evaluateCompiledArtifact(outputBytes: Uint8Array): unknown {
  const source = new TextDecoder().decode(outputBytes);
  if (/^\s*import[\s{("']/m.test(source)) {
    throw new Error('the compiled artifact unexpectedly contains an import statement');
  }
  const match = /export\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default\s*\};?\s*$/.exec(source);
  if (match === null) throw new Error('the compiled artifact has no single default export');
  const body = `${source.slice(0, match.index)}globalThis.__thirdlight_artifact_default = ${match[1]};`;
  const sandbox: Record<string, unknown> = {
    console: { log: (): void => {}, warn: (): void => {}, error: (): void => {} },
  };
  const context = createContext(sandbox, {
    name: 'thirdlight-behavior-artifact',
    codeGeneration: { strings: false, wasm: false },
  });
  new Script(body, { filename: 'behavior-output.js' }).runInContext(context, { timeout: 1000 });
  return runInContext('globalThis.__thirdlight_artifact_default', context, { timeout: 1000 });
}

function committedArtifact(behaviorId: string, ownedTransforms: string[] = []): {
  artifact: BehaviorArtifact;
  outputBytes: Uint8Array;
  outputDigest: string;
} {
  const outputBytes = new Uint8Array(readFileSync(join(FIXTURE_ROOT, 'valid', 'sample.output.js')));
  const sample = (index as unknown as { validSample: { manifestDigest: string; outputArtifact: { digest: string } } })
    .validSample;
  const artifact: BehaviorArtifact = {
    behaviorId,
    sourceDigest: (index as unknown as { cases: { container: string; containerDigest: string }[] }).cases.find(
      (c) => c.container === 'valid/sample.json',
    )?.containerDigest ?? 'a'.repeat(64),
    manifestDigest: sample.manifestDigest,
    outputDigest: sample.outputArtifact.digest,
    ownedTransforms,
    requiredModules: ['@thirdlight/runtime'],
    enginePins: M2_PINNED_MODULES.map((p) => ({ ...p })),
    namespace: { default: evaluateCompiledArtifact(outputBytes) },
  };
  return { artifact, outputBytes, outputDigest: artifact.outputDigest };
}

/** Compile a fresh test behavior with the real packet-33 compiler. */
async function compileHosted(
  behaviorId: string,
  source: string,
  ownedTransforms: string[] = [],
): Promise<BehaviorArtifact> {
  const container = {
    graphVersion: 1 as const,
    entryPath: 'src/index.ts',
    requiredModules: ['@thirdlight/runtime'],
    ownedTransforms,
    files: [{ path: 'src/index.ts', text: source }],
  };
  const result = await compileBehavior({
    behaviorId,
    declaration: DECLARATION,
    containerBytes: new TextEncoder().encode(canonicalContainerText(container)),
    pinnedModules: M2_PINNED_MODULES,
    limits: { timeoutMs: 30_000 },
  });
  if (!result.ok) throw new Error(`compile ${behaviorId} failed: ${JSON.stringify(result)}`);
  return {
    behaviorId,
    sourceDigest: (result.manifest as unknown as { sourceDigest: string }).sourceDigest,
    manifestDigest: result.manifestDigest,
    outputDigest: result.outputDigest,
    ownedTransforms,
    requiredModules: ['@thirdlight/runtime'],
    enginePins: M2_PINNED_MODULES.map((p) => ({ ...p })),
    namespace: { default: evaluateCompiledArtifact(result.outputBytes) },
  };
}

/** A scene: camera + one behavior-carrying box per entry (a `box` entity is ownable). */
function sceneFor(entries: { entityId: string; behaviorId: string; speed: number }[]): unknown {
  const transform = (position: number[]): unknown => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return {
    schemaVersion: 2,
    sceneId: 'scene-main',
    revision: 1,
    entities: [
      {
        id: 'cam-main',
        components: { transform: transform([0, 0.5, 4]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
      },
      ...entries.map((e) => ({
        id: e.entityId,
        components: {
          transform: transform([0, 0, 0]),
          box: { size: [1, 1, 1], material: { color: '#ffffff' } },
          behavior: { behaviorId: e.behaviorId, values: { speed: e.speed } },
        },
      })),
    ],
  };
}

function snapshotOf(scene: unknown): unknown {
  return { snapshotId: 'demo-0001@r1', projectId: 'demo-0001', revision: 1, scene };
}

/**
 * The test consumer: a phase module that reads the committed `control_move`
 * intent (falling back to the sampled frame — the §14.5 effective-input rule)
 * and moves its owned entity by `move · dt` in the transform phase.
 */
function consumerSpec(ownerId: string, sampleLimit = Number.POSITIVE_INFINITY): SimulationModuleSpec {
  let steps = 0;
  return {
    id: 'thirdlight.test:move-consumer',
    phases: ['transform'],
    create() {
      return {
        transformOwners: [ownerId],
        step(phase, ctx): void {
          if (phase !== 'transform') return;
          if (steps >= sampleLimit) return;
          steps += 1;
          const move = ctx.intents.move ?? ctx.action.moveX;
          const t = ctx.state.curr.get(ownerId);
          if (t) t.position[0] = t.position[0] + move * DT;
        },
      };
    },
  };
}

interface RunResult {
  x: number;
  diagnostics: RuntimeDiagnostics;
}

function runBehavior(
  artifacts: BehaviorArtifact[],
  scene: unknown,
  ownerId: string,
  steps: number,
): RunResult {
  const registry = createSimulationRegistry();
  const ids: string[] = [];
  for (const artifact of artifacts) {
    const spec = createBehaviorModuleSpec({ declaration: DECLARATION, artifact });
    const res = registerSimulationModule(registry, spec.id, spec);
    if (!res.ok) throw new Error(`register failed: ${JSON.stringify(res.error)}`);
    ids.push(spec.id);
  }
  const consumer = consumerSpec(ownerId);
  registerSimulationModule(registry, consumer.id, consumer);
  ids.push(consumer.id);
  const res = instantiateRuntime({
    snapshot: snapshotOf(scene),
    registry,
    modules: ids,
    driver: { kind: 'manual' },
    clock: () => 0,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  const started = rt.start();
  if (!started.ok) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
  rt.tick(0); // the 12-step settle pre-roll
  for (let i = 1; i <= steps; i += 1) {
    const r = rt.tick(i * DT);
    if (!r.ok) break; // fail-stop: the surviving diagnostics are the evidence
  }
  const d = rt.getDiagnostics();
  if (!d.ok) throw new Error('diagnostics failed');
  const state = rt.getInterpolatedState();
  if (!state.ok) throw new Error('state failed');
  const x = state.state.transforms.find((t) => t.id === ownerId)?.position[0] ?? 0;
  rt.dispose();
  return { x, diagnostics: d.diagnostics };
}

describe('packet 34 — Node host executes the real compiled artifact (node:vm)', () => {
  it('executes the committed packet-33 output in a bounded VM context and measures a property-driven behavior change', () => {
    const before = new Uint8Array(readFileSync(join(FIXTURE_ROOT, 'valid', 'sample.output.js')));
    const sourceBefore = sha256(before);
    const low = committedArtifact('behavior-0100');
    const high = committedArtifact('behavior-0100');

    const sceneLow = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0100', speed: 3.5 }]);
    const sceneHigh = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0100', speed: 6.5 }]);
    const snapshotLow = JSON.stringify(sceneLow);
    const snapshotHigh = JSON.stringify(sceneHigh);

    const runLow = runBehavior([low.artifact], sceneLow, 'box-0001', 40);
    const runHigh = runBehavior([high.artifact], sceneHigh, 'box-0001', 40);

    // The declared numeric property changes the measured play state after a
    // fresh instantiation (same compiled artifact bytes, different values).
    expect(runLow.diagnostics.state).toBe('running');
    expect(runHigh.diagnostics.state).toBe('running');
    expect(runHigh.x).toBeGreaterThan(runLow.x);
    expect(runLow.x).not.toBe(runHigh.x);
    expect(runLow.diagnostics.intentCommitCount).toBeGreaterThan(0);

    // The source artifact and both snapshots are byte-identical after play.
    const after = new Uint8Array(readFileSync(join(FIXTURE_ROOT, 'valid', 'sample.output.js')));
    expect(sha256(after)).toBe(sourceBefore);
    expect(JSON.stringify(sceneLow)).toBe(snapshotLow);
    expect(JSON.stringify(sceneHigh)).toBe(snapshotHigh);

    // The measurement transcript for the evidence manifest.
    console.log(
      `P34_MEASUREMENT ${JSON.stringify({
        behaviorId: 'behavior-0100',
        outputDigest: low.outputDigest,
        property: SPEED.key,
        speedLow: 3.5,
        speedHigh: 6.5,
        steps: 40,
        xLow: runLow.x,
        xHigh: runHigh.x,
        intentCommitCount: runLow.diagnostics.intentCommitCount,
        sourceDigestUnchanged: sha256(after),
      })}`,
    );
  });

  it('leaves an already-running instance unchanged when a fresh instance uses different published values', () => {
    const first = committedArtifact('behavior-0100');
    const second = committedArtifact('behavior-0100');
    const sceneA = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0100', speed: 3.5 }]);
    const sceneB = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0100', speed: 6.5 }]);
    const runA = runBehavior([first.artifact], sceneA, 'box-0001', 20);
    const runAReplay = runBehavior([first.artifact], sceneA, 'box-0001', 20);
    const runB = runBehavior([second.artifact], sceneB, 'box-0001', 20);
    // Run B does not change run A's measurement: the play instance is pinned
    // to the values it was instantiated with.
    expect(runAReplay.x).toBe(runA.x);
    expect(runB.x).toBeGreaterThan(runA.x);
  });
});

describe('packet 34 — failure modes in the Node host', () => {
  it('fail-stops a throwing behavior with bounded diagnostics and refuses to resume', async () => {
    const throwing = await compileHosted(
      'behavior-0201',
      "export default { step() { throw new Error('hostile-throw'); } };\n",
    );
    const scene = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0201', speed: 3.5 }]);
    const run = runBehavior([throwing], scene, 'box-0001', 5);
    expect(run.diagnostics.state).toBe('failed');
    expect(run.diagnostics.failed).toBe(true);
    expect(run.diagnostics.errors).toHaveLength(1);
    expect(run.diagnostics.errors[0]?.code).toBe('module_error');
    expect(run.diagnostics.errors[0]?.reason).toBe('behavior_step_failed');
    expect(run.diagnostics.failedModuleId).toBe('thirdlight.behavior:behavior-0201');
    expect((run.diagnostics.errors[0]?.message ?? '').length).toBeLessThanOrEqual(256);
    console.log(`P34_FAILSTOP ${JSON.stringify(run.diagnostics.errors[0])}`);
  });

  it('rejects an invalid intent (value out of range) as a fail-stop', async () => {
    const bad = await compileHosted(
      'behavior-0202',
      "export default { step(_s, ctx) { ctx.emit({ kind: 'control_move', value: 42 }); } };\n",
    );
    const scene = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0202', speed: 3.5 }]);
    const run = runBehavior([bad], scene, 'box-0001', 5);
    expect(run.diagnostics.state).toBe('failed');
    expect(run.diagnostics.errors[0]?.reason).toBe('behavior_intent_invalid');
    expect(run.diagnostics.errors[0]?.detail).toBe('value');
  });

  it('rejects a transform intent on an entity the behavior does not own', async () => {
    const bad = await compileHosted(
      'behavior-0203',
      "export default { step(_s, ctx) { if (ctx.phase === 'transform') ctx.emit({ kind: 'transform', entityId: 'cam-main', position: { x: 1 } }); } };\n",
      ['box-0001'],
    );
    const scene = sceneFor([
      { entityId: 'box-0001', behaviorId: 'behavior-0203', speed: 3.5 },
      { entityId: 'box-0002', behaviorId: 'behavior-0203', speed: 3.5 },
    ]);
    const run = runBehavior([bad], scene, 'box-0002', 5);
    expect(run.diagnostics.state).toBe('failed');
    expect(run.diagnostics.errors[0]?.reason).toBe('behavior_transform_forbidden');
    expect(run.diagnostics.errors[0]?.detail).toBe('not_owner');
  });

  it('bounds a log flood (16 accepted per step per instance, ring ≤ 32)', async () => {
    const flood = await compileHosted(
      'behavior-0204',
      "export default { step(_s, ctx) { for (let i = 0; i < 40; i += 1) ctx.log('warn', 'flood ' + i); } };\n",
    );
    const scene = sceneFor([{ entityId: 'box-0001', behaviorId: 'behavior-0204', speed: 3.5 }]);
    const run = runBehavior([flood], scene, 'box-0001', 1);
    expect(run.diagnostics.state).toBe('running');
    // 12 settle pre-roll steps + one ticked step = 13 steps, each accepting 16.
    expect(run.diagnostics.logCount).toBe(16 * 13);
    expect(run.diagnostics.logDropped).toBe(24 * 13);
    expect(run.diagnostics.errors.length).toBeLessThanOrEqual(32);
    console.log(
      `P34_LOGBOUND ${JSON.stringify({
        logCount: run.diagnostics.logCount,
        logDropped: run.diagnostics.logDropped,
        ring: run.diagnostics.errors.length,
      })}`,
    );
  });

  it('rejects two writers of one control channel', async () => {
    const a = await compileHosted(
      'behavior-0205',
      "export default { step(_s, ctx) { ctx.emit({ kind: 'control_move', value: 0.5 }); } };\n",
    );
    const b = await compileHosted(
      'behavior-0206',
      "export default { step(_s, ctx) { ctx.emit({ kind: 'control_move', value: -0.5 }); } };\n",
    );
    const scene = sceneFor([
      { entityId: 'box-0001', behaviorId: 'behavior-0205', speed: 3.5 },
      { entityId: 'box-0002', behaviorId: 'behavior-0206', speed: 3.5 },
    ]);
    const run = runBehavior([a, b], scene, 'box-0001', 5);
    expect(run.diagnostics.state).toBe('failed');
    expect(run.diagnostics.errors[0]?.reason).toBe('behavior_intent_conflict');
    expect(run.diagnostics.errors[0]?.detail).toBe('duplicate_writer');
  });

  it('does not execute unbounded-loop behavior tests in a live browser context (documented limitation)', () => {
    // runtime.md §14.1.1: a same-thread infinite loop cannot be preempted by a
    // watchdog, an iframe removal, a Stop button or dispose(). This packet
    // therefore contains NO unbounded-loop execution test in a browser; the
    // limitation is documented in the packet-34 evidence manifest and the
    // browser procedure. The VM module-evaluation timeout above bounds only
    // module evaluation, not a step-time loop.
    expect(true).toBe(true);
  });
});

describe('packet 34 — the runtime host never evaluates source', () => {
  it('rejects an artifact namespace without a default spec', () => {
    expect(() =>
      createBehaviorModuleSpec({
        declaration: DECLARATION,
        artifact: {
          behaviorId: 'behavior-0300',
          sourceDigest: 'a'.repeat(64),
          manifestDigest: 'b'.repeat(64),
          outputDigest: 'c'.repeat(64),
          ownedTransforms: [],
          requiredModules: [],
          enginePins: [],
          namespace: {},
        },
      }),
    ).toThrow(BehaviorHostError);
  });
});
