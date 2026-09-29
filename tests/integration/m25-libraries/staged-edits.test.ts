/**
 * Staged library edits — several patches, one commit, the
 * dependents compiled once — on the real filesystem with the real compiler.
 *
 * Two libraries (`base`, and `mid` which imports it) and two published
 * scripts that import `mid`. A stage takes four patches (a new file sent in
 * two pieces, the entry changed, `base` changed) without changing the
 * project; committing it is one revision whose change carries both libraries
 * and both scripts' new records, each script compiled once; one undo puts
 * everything back and redo re-applies it. A stage made on a library that
 * changed since, a stage committed twice, and a discarded stage are refused.
 */
import { describe, expect, it } from 'vitest';

import { acknowledgePreparedDigest, publishBehaviorSource } from '@thirdlight/backend/services';
import { scriptLibraryDigest } from '@thirdlight/project-model';

import { envelopeJson, makeBuildEnv, requestId, sha256Hex, ORIGIN, type BuildEnv } from '../m2-builds/helpers';

type Any = any;
let n = 0x25900;
const rid = (): string => requestId((n += 1));
const revision = (env: BuildEnv): number => envelopeJson(env).scene.revision;

function command(env: BuildEnv, op: string, args: Record<string, unknown>): Any {
  return env.svc.runCommand({ op, projectId: env.project, expectedRevision: revision(env), requestId: rid(), origin: ORIGIN, args });
}
function ok(env: BuildEnv, op: string, args: Record<string, unknown>): Any {
  const r = command(env, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 500)).toBe(true);
  return r;
}
function trust(env: BuildEnv, digest: string): void {
  const r = acknowledgePreparedDigest(env.svc, { projectId: env.project, sourceDigest: digest, expectedRevision: revision(env), requestId: rid(), origin: ORIGIN });
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

const BASE = { libraryId: 'base', name: 'Base', files: [{ path: 'src/index.ts', text: 'export const unit = 2;\n' }] };
const MID = { libraryId: 'mid', name: 'Mid', files: [{ path: 'src/index.ts', text: "import { unit } from '@lib/base';\nexport const amount = (n: number): number => n * unit;\n" }] };

function script(key: string): string {
  return [
    "import type { BehaviorContext } from '@thirdlight/runtime';",
    "import { amount } from '@lib/mid';",
    '',
    'export default {',
    '  step(_state: unknown, ctx: BehaviorContext): void {',
    `    if (ctx.phase === 'intent' && ctx.game?.counter('${key}') === 0) ctx.game.add('${key}', amount(1));`,
    '  },',
    '};',
    '',
  ].join('\n');
}

async function publish(env: BuildEnv, behaviorId: string): Promise<void> {
  ok(env, 'publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration: { properties: [] } });
  const bytes = new TextEncoder().encode(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: script(behaviorId) }] }, null, 2)}\n`);
  const stageId = `stage-${(n += 1).toString(16)}`;
  const staged = env.svc.stageContent(env.project, { stageId, bytes });
  expect(staged.ok).toBe(true);
  trust(env, sha256Hex(bytes));
  const r = await publishBehaviorSource(env.svc, { projectId: env.project, stageId, behaviorId, displayName: behaviorId, declaration: { properties: [] } as never, expectedRevision: revision(env), requestId: rid(), origin: ORIGIN });
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
}

const libraries = (env: BuildEnv): Any[] => (envelopeJson(env).content as Any).scriptLibraries ?? [];
const record = (env: BuildEnv, behaviorId: string): Any => envelopeJson(env).content.behaviors.find((b) => b.behaviorId === behaviorId)?.source;

async function setup(tag: string): Promise<BuildEnv> {
  const env = makeBuildEnv(tag);
  ok(env, 'setScriptLibrary', BASE);
  ok(env, 'setScriptLibrary', MID);
  trust(env, scriptLibraryDigest(BASE));
  trust(env, scriptLibraryDigest(MID));
  await publish(env, 'user-a');
  await publish(env, 'user-b');
  return env;
}

describe('phase 25.9: staged library edits', () => {
  it('several patches, one commit: one revision, both libraries, each dependent compiled once, one undo', async () => {
    const env = await setup('m25-staged');
    const before = { rev: revision(env), a: record(env, 'user-a'), b: record(env, 'user-b'), libs: libraries(env) };
    expect(before.a.libraries.map((p: Any) => p.libraryId)).toEqual(['base', 'mid']);

    // Four patches: a data file in two pieces, the entry reading it, and base.
    const s1 = env.svc.stageScriptLibraryPatch(env.project, { patch: { libraryId: 'mid', files: [{ path: 'src/table.json', text: '{ "factor":' }] } });
    if (!s1.ok) throw new Error(JSON.stringify(s1));
    const stageId = s1.stage.stageId;
    const s2 = env.svc.stageScriptLibraryPatch(env.project, { stageId, patch: { libraryId: 'mid', files: [{ path: 'src/table.json', text: ' 5 }\n', append: true }] } });
    const s3 = env.svc.stageScriptLibraryPatch(env.project, { stageId, patch: { libraryId: 'mid', files: [{ path: 'src/index.ts', text: "import { unit } from '@lib/base';\nimport table from './table.json';\nexport const amount = (n: number): number => n * unit * table.factor;\n" }] } });
    const s4 = env.svc.stageScriptLibraryPatch(env.project, { stageId, patch: { libraryId: 'base', files: [{ path: 'src/index.ts', text: 'export const unit = 3;\n' }] } });
    for (const s of [s2, s3, s4]) expect(s.ok, JSON.stringify(s)).toBe(true);
    if (!s4.ok) return;
    expect(s4.stage.patches).toBe(4);
    expect(s4.stage.libraries.map((l) => [l.libraryId, l.changed, l.files])).toEqual([['base', true, 1], ['mid', true, 2]]);
    // Staging changed nothing.
    expect(revision(env)).toBe(before.rev);
    expect(libraries(env)).toEqual(before.libs);

    // The staged digests are acknowledged, then the dependents compile once each against the committed set.
    for (const l of s4.stage.libraries) trust(env, l.sourceDigest);
    const misses = env.compiler.cacheStats!().misses;
    const prep = await env.svc.prepareScriptLibraryStage(env.project, stageId);
    if (!prep.ok) throw new Error(JSON.stringify(prep));
    expect(prep.compiled).toBe(2);
    expect(prep.dependents.map((d) => d.behaviorId)).toEqual(['user-a', 'user-b']);
    expect(env.compiler.cacheStats!().misses - misses).toBe(2);

    const trustedRev = revision(env);
    const committed = ok(env, 'commitScriptLibraryStage', { stageId });
    expect(committed.revision).toBe(trustedRev + 1);
    expect(committed.change.type).toBe('setScriptLibraries');
    expect(committed.change.libraries.map((l: Any) => l.libraryId)).toEqual(['base', 'mid']);
    expect(committed.change.behaviors.map((b: Any) => b.behaviorId)).toEqual(['user-a', 'user-b']);
    const mid = libraries(env).find((l) => l.libraryId === 'mid');
    expect(mid.files.find((f: Any) => f.path === 'src/table.json').text).toBe('{ "factor": 5 }\n');
    const a = record(env, 'user-a');
    expect(a.outputDigest).toBe(prep.dependents[0]!.outputDigest);
    expect(a.outputDigest).not.toBe(before.a.outputDigest);
    expect(a.libraries).toEqual([
      { libraryId: 'base', sourceDigest: s4.stage.libraries[0]!.sourceDigest },
      { libraryId: 'mid', sourceDigest: s4.stage.libraries[1]!.sourceDigest },
    ]);
    // The stage is gone once committed.
    const again = command(env, 'commitScriptLibraryStage', { stageId });
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('reference_missing');

    // One undo puts both libraries and both records back; redo re-applies them.
    ok(env, 'undo', {});
    expect(libraries(env)).toEqual(before.libs);
    expect(record(env, 'user-a').outputDigest).toBe(before.a.outputDigest);
    expect(record(env, 'user-b').outputDigest).toBe(before.b.outputDigest);
    ok(env, 'redo', {});
    expect(record(env, 'user-a').outputDigest).toBe(a.outputDigest);
    expect(libraries(env).find((l) => l.libraryId === 'mid').files).toHaveLength(2);
    env.svc.dispose();
  }, 120_000);

  it('refuses a stage made on a library that changed since, an append without a file, a discarded stage', async () => {
    const env = await setup('m25-staged-refusals');
    const s = env.svc.stageScriptLibraryPatch(env.project, { patch: { libraryId: 'base', files: [{ path: 'src/index.ts', text: 'export const unit = 7;\n' }] } });
    if (!s.ok) throw new Error(JSON.stringify(s));
    trust(env, s.stage.libraries[0]!.sourceDigest);
    // Someone changes base directly (its dependents recompiled by that command).
    const direct = { libraryId: 'base', files: [{ path: 'src/index.ts', text: 'export const unit = 9;\n' }] };
    trust(env, scriptLibraryDigest({ files: direct.files }));
    await env.svc.prepareScriptLibraryDependents(env.project, direct);
    ok(env, 'setScriptLibrary', direct);
    const stale = command(env, 'commitScriptLibraryStage', { stageId: s.stage.stageId });
    expect(stale.ok).toBe(false);
    expect(stale.error.code).toBe('field_value');
    expect(stale.error.message).toContain('@lib/base changed since it was staged');

    const orphan = env.svc.stageScriptLibraryPatch(env.project, { patch: { libraryId: 'mid', files: [{ path: 'src/none.ts', text: 'x', append: true }] } });
    expect(orphan.ok).toBe(false);

    const t = env.svc.stageScriptLibraryPatch(env.project, { patch: { libraryId: 'mid', name: 'Middle' } });
    if (!t.ok) throw new Error(JSON.stringify(t));
    expect(env.svc.discardScriptLibraryStage(env.project, t.stage.stageId).ok).toBe(true);
    const gone = command(env, 'commitScriptLibraryStage', { stageId: t.stage.stageId });
    expect(gone.error.code).toBe('reference_missing');
    expect(command(env, 'commitScriptLibraryStage', { stageId: 'nope' }).error.code).toBe('field_type');
    env.svc.dispose();
  }, 120_000);
});

describe('phase 25.9: records published before shared libraries', () => {
  it('a record with the bundled (23.7) output still builds: the closure re-derives it and ships the shared modules', async () => {
    const { createBehaviorCompiler } = await import('@thirdlight/behavior-build');
    const { openWorkspaceService } = await import('@thirdlight/workspace');
    const { buildContentClosureM3 } = await import('@thirdlight/exporter');
    const { makeRoot } = await import('../m2-builds/helpers');
    const root = makeRoot('m25-legacy-record');
    const real = createBehaviorCompiler({ now: () => Date.now() });
    // First a compiler that bundles libraries into each script (how older records were built), then the linking one.
    let bundled = true;
    const compiler = { pinnedModules: real.pinnedModules, compile: (i: Any) => real.compile(bundled ? { ...i, libraryLinking: 'bundle' } : i), checkLibrary: real.checkLibrary };
    const old: BuildEnv = { root, project: 'demo-build-01', svc: openWorkspaceService({ root, behaviorCompiler: compiler as never }), compiler: real };
    expect(old.svc.createProject(old.project, 'Legacy').ok).toBe(true);
    ok(old, 'setScriptLibrary', BASE);
    ok(old, 'setScriptLibrary', MID);
    trust(old, scriptLibraryDigest(BASE));
    trust(old, scriptLibraryDigest(MID));
    await publish(old, 'user-a');
    const recorded = record(old, 'user-a').outputDigest as string;
    bundled = false;

    const svc = old.svc;
    const captured = svc.readCapturedV3(old.project) as Any;
    expect(captured.ok, JSON.stringify(captured).slice(0, 400)).toBe(true);
    const built = await buildContentClosureM3({
      service: svc,
      compiler: compiler as never,
      projectId: old.project,
      revision: captured.revision ?? 1,
      capturedAt: '2026-09-28T00:00:00Z',
      scene: captured.read.scene,
      content: captured.read.content,
      ...(captured.read.scenes !== undefined ? { scenes: captured.read.scenes, startScenes: captured.read.startScenes ?? [] } : {}),
    });
    expect(built.ok, JSON.stringify(built).slice(0, 400)).toBe(true);
    if (!built.ok) return;
    const c = built.closure;
    // The shipped script is the shared form (it imports mid's module); mid imports base's.
    expect(c.behaviors[0]!.outputDigest).not.toBe(recorded);
    expect(c.libraryArtifacts.map((a) => a.path)).toEqual(c.manifest.libraries!.map((l) => l.path));
    expect(c.manifest.libraries!.map((l) => l.libraryId)).toEqual(['base', 'mid']);
    const mid = c.manifest.libraries!.find((l) => l.libraryId === 'mid')!;
    expect(new TextDecoder().decode(c.behaviorArtifacts[0]!.bytes)).toContain(`../libraries/${mid.outputDigest}.js`);
    expect(c.declaredPaths).toEqual(expect.arrayContaining(c.libraryArtifacts.map((a) => a.path)));
    // Maps for every shipped module (Play maps error locations with them).
    expect(c.sourceMaps.map((m) => m.libraryId ?? m.behaviorId).sort()).toEqual(['base', 'mid', 'user-a']);
    svc.dispose();
  }, 120_000);
});
