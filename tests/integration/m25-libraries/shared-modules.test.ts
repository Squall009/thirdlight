/**
 * Phase 25.9: script libraries as shared runtime modules, run by the
 * production game host in the page (single thread) and in the simulation
 * worker (a Node worker thread running the game-host worker core).
 *
 * Two scripts import one library (`@lib/tally`), compiled by the real
 * compiler. The outputs are written the way Play and exports lay them out
 * (`behaviors/<digest>.js`, `libraries/<digest>.js`) and imported by file
 * URL, so the scripts' `../libraries/<digest>.js` imports load the one
 * library module:
 *
 * - the library is one module instance per realm (its counter is shared: the
 *   two scripts log 1 and 2, not 1 and 1), and neither script carries the
 *   library's code;
 * - a `ctx.log` records where the script called it and a throw inside the
 *   library records its frames; the backend's mapping (the build's source
 *   maps) turns them into the library's and the script's own files, lines
 *   and columns.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { M2_PINNED_MODULES, compileBehavior, type SharedLibraryModule } from '@thirdlight/behavior-build';
import { mapCompiledLocation, type SourceMapTable } from '@thirdlight/backend/services';
import { scriptLibraryContainerText } from '@thirdlight/project-model';

import { makeRoot } from '../m2-builds/helpers';
import { startHarness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

const LIBRARY = [
  'let calls = 0;',
  '',
  '/** The next number of one counter every importer shares. */',
  'export function next(): number {',
  '  calls += 1;',
  '  return calls;',
  '}',
  '',
  '// eslint-disable-next-line @typescript-eslint/no-unused-vars',
  'function unused(): string {',
  "  return 'this function is shaken out of the module';",
  '}',
  '',
  'export function check(step: number): number {',
  '  if (step >= 40) throw new Error(`the tally gave up at step ${step}`);',
  '  return step;',
  '}',
  '',
].join('\n');
const LIBRARY_THROW_LINE = 15;

function user(logStep: number, checks: boolean): string {
  return [
    "import type { BehaviorContext } from '@thirdlight/runtime';",
    "import { check, next } from '@lib/tally';",
    '',
    'export default {',
    '  step(_state: unknown, ctx: BehaviorContext): void {',
    "    if (ctx.phase !== 'intent') return;",
    `    if (ctx.stepIndex === ${logStep}) ctx.log('info', \`tally \${next()}\`);`,
    `    if (${checks ? 'true' : 'false'}) check(ctx.stepIndex);`,
    '  },',
    '};',
    '',
  ].join('\n');
}
const LOG_LINE = 7;
const CHECK_LINE = 8;

const root = makeRoot('m25-shared-modules');
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Built {
  behaviors: { row: Any; url: string }[];
  modules: SharedLibraryModule[];
  maps: SourceMapTable;
  outputs: string[];
}

async function build(): Promise<Built> {
  const library = { libraryId: 'tally', containerBytes: new TextEncoder().encode(scriptLibraryContainerText({ files: [{ path: 'src/index.ts', text: LIBRARY }] })) };
  const dir = join(root, 'play');
  mkdirSync(join(dir, 'behaviors'), { recursive: true });
  mkdirSync(join(dir, 'libraries'), { recursive: true });
  const behaviors: { row: Any; url: string }[] = [];
  const modules = new Map<string, SharedLibraryModule>();
  const maps = new Map<string, { behaviorId?: string; libraryId?: string; sourceMap: string }>();
  const outputs: string[] = [];
  for (const [behaviorId, logStep, checks] of [['user-a', 5, false], ['user-b', 6, true]] as const) {
    const container = { graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: user(logStep, checks) }] };
    const bytes = new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`);
    const r = await compileBehavior({ behaviorId, declaration: { properties: [] }, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES, libraries: [library] });
    if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r)}`);
    const file = join(dir, 'behaviors', `${r.outputDigest}.js`);
    writeFileSync(file, r.outputBytes);
    outputs.push(new TextDecoder().decode(r.outputBytes));
    maps.set(r.outputDigest, { behaviorId, sourceMap: r.sourceMap ?? '' });
    for (const m of r.libraryModules ?? []) {
      modules.set(m.outputDigest, m);
      maps.set(m.outputDigest, { libraryId: m.libraryId, sourceMap: m.sourceMap });
      writeFileSync(join(dir, 'libraries', `${m.outputDigest}.js`), m.outputBytes);
    }
    behaviors.push({
      row: { behaviorId, sourceDigest: 'a'.repeat(64), manifestDigest: r.manifestDigest, outputDigest: r.outputDigest, declaration: r.manifest.declaration, ownedTransforms: [], requiredModules: r.manifest.requiredModules, path: `behaviors/${r.outputDigest}.js` },
      url: pathToFileURL(file).href,
    });
  }
  return { behaviors, modules: [...modules.values()], maps, outputs };
}

function level(): Any {
  const scripted = (id: string, behaviorId: string, x: number) => ({ id, components: { transform: at(x, 1), box: { size: [0.5, 0.5, 0.5], material: { color: '#88aacc' } }, behavior: { behaviorId, values: {} } } });
  return {
    snapshotId: 'libs@r1',
    projectId: 'libs',
    revision: 1,
    scene: {
      schemaVersion: 4,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 } } },
        scripted('box-a', 'user-a', 2),
        scripted('box-b', 'user-b', 4),
      ],
    },
  };
}

async function run(mode: Mode, built: Built): Promise<Any[]> {
  const h = await startHarness(mode, { snapshot: level(), settings: SETTINGS, physics: null, behaviors: built.behaviors, enginePins: M2_PINNED_MODULES });
  try {
    let now = 10;
    await h.tick(now);
    for (let i = 0; i < 80; i += 1) {
      now += 1 / HZ;
      // The library throws at step 40: the runtime fail-stops and refuses further ticks.
      const failed = await h.tick(now).then(() => false, (e: unknown) => String(e).includes('runtime_failed'));
      if (failed) break;
    }
    const d = h.rt.getDiagnostics() as Any;
    return (d.diagnostics?.errors ?? d.errors ?? []) as Any[];
  } finally {
    await h.dispose();
  }
}

describe('phase 25.9: shared library modules in the page and the worker', () => {
  it('two scripts share one library module; logs and errors map back to the library and script sources', async () => {
    const built = await build();
    expect(built.modules).toHaveLength(1);
    const lib = built.modules[0]!;
    // Compiled once, minified and tree-shaken; the scripts import it and carry none of its code.
    const libText = new TextDecoder().decode(lib.outputBytes);
    expect(libText).not.toContain('shaken out');
    expect(libText).not.toContain('\n  ');
    expect(lib.exports).toEqual(['check', 'next']);
    for (const out of built.outputs) {
      expect(out).toContain(`from "../libraries/${lib.outputDigest}.js"`);
      expect(out).not.toContain('gave up');
    }
    for (const mode of ['single', 'worker'] as const) {
      const errors = await run(mode, built);
      const logs = errors.filter((e) => e.code === 'behavior_log');
      // One instance per realm: the two scripts count on the same counter.
      expect(logs.map((e) => e.message), mode).toEqual(['tally 1', 'tally 2']);
      for (const [i, e] of logs.entries()) {
        expect(e.at?.file, mode).toMatch(/^behaviors\/[0-9a-f]{64}\.js$/);
        const src = mapCompiledLocation(e.at, built.maps);
        expect(src, mode).toMatchObject({ behaviorId: i === 0 ? 'user-a' : 'user-b', path: 'src/index.ts', line: LOG_LINE });
      }
      // The throw inside the library: a fail-stop whose frames are the library's line, then the script's call.
      const failure = errors.find((e) => e.code !== 'behavior_log');
      expect(failure?.message, mode).toContain('the tally gave up at step 40');
      expect(failure?.at?.file, mode).toBe(`libraries/${lib.outputDigest}.js`);
      expect(mapCompiledLocation(failure.at, built.maps), mode).toMatchObject({ libraryId: 'tally', path: 'src/index.ts', line: LIBRARY_THROW_LINE });
      const frames = (failure.frames as Any[]).map((f) => mapCompiledLocation(f, built.maps));
      expect(frames[1], mode).toMatchObject({ behaviorId: 'user-b', path: 'src/index.ts', line: CHECK_LINE });
    }
  }, 120_000);
});
