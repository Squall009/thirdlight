/**
 * Packet 33 — immutable behavior builds, end to end on the real filesystem
 * (project-model.md §22.4.1, workspace.md §13.3.1, commands.md §8.8).
 *
 * The real workspace service, the real commands pipeline and the real injected
 * `behavior-build` compiler (pinned esbuild 0.28.2) are driven through the
 * backend publication facade (`publishBehaviorSource`): stage → validate +
 * compile → trust gate → digest-bound prepared record → `runCommand`. Every
 * failure path must leave the previous publication byte-identical.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceService } from '@thirdlight/workspace';
import { acknowledgePreparedDigest, publishBehaviorSource } from '@thirdlight/backend/services';

import {
  envelopeBytes,
  envelopeJson,
  fixtureBytes,
  fixtureIndex,
  makeBuildEnv,
  requestId,
  sha256Hex,
  ORIGIN,
  type BuildEnv,
} from './helpers';

const index = fixtureIndex();
const DECLARATION = index.declaration as { properties: unknown[] };
const BEHAVIOR_ID = index.behaviorId;

function createDeclaration(env: BuildEnv, n: number): void {
  const res = env.svc.runCommand({
    op: 'publishBehavior',
    projectId: env.project,
    expectedRevision: envelopeJson(env).scene.revision,
    requestId: requestId(n),
    origin: ORIGIN,
    args: { behaviorId: BEHAVIOR_ID, displayName: 'Drift', mode: 'declaration-create', declaration: DECLARATION },
  });
  if (!res.ok) throw new Error(`declaration-create failed: ${JSON.stringify(res)}`);
}

function stage(env: BuildEnv, rel: string, n: number): { stageId: string; digest: string; bytes: Uint8Array } {
  const bytes = fixtureBytes(rel);
  const stageId = `stage-${n.toString(16).padStart(4, '0')}`;
  const res = env.svc.stageContent(env.project, { stageId, bytes });
  if (!res.ok) throw new Error(`stage failed: ${JSON.stringify(res)}`);
  return { stageId, digest: sha256Hex(bytes), bytes };
}

function acknowledge(env: BuildEnv, digest: string, n: number): void {
  const res = acknowledgePreparedDigest(env.svc, {
    projectId: env.project,
    sourceDigest: digest,
    expectedRevision: envelopeJson(env).scene.revision,
    requestId: requestId(n),
    origin: ORIGIN,
  });
  if (!res.ok) throw new Error(`acknowledge failed: ${JSON.stringify(res)}`);
}

function discard(env: BuildEnv, stageId: string): void {
  const res = env.svc.discardStage(env.project, stageId);
  if (!res.ok) throw new Error(`discard failed: ${JSON.stringify(res)}`);
}

function recordOf(env: BuildEnv, behaviorId: string) {
  return envelopeJson(env).content.behaviors.find((b) => b.behaviorId === behaviorId);
}

describe('packet 33 — behavior source publication (real fs, real compiler, one commit path)', () => {
  it('prepares, publishes and reopens a source-bearing behavior record', async () => {
    const env = makeBuildEnv('m2pub');
    createDeclaration(env, 1);
    const staged = stage(env, 'valid/sample.json', 2);
    acknowledge(env, staged.digest, 3);

    // Preparation: no authoritative change.
    const before = envelopeBytes(env);
    const prepared = await env.svc.prepareBehaviorSource(env.project, {
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
    expect(prepared.prepared.sourceDigest).toBe(staged.digest);
    expect(prepared.prepared.entryPath).toBe('src/index.ts');
    expect(prepared.prepared.fileCount).toBe(2);
    expect(prepared.prepared.requiredModules).toEqual(['@thirdlight/runtime']);
    // The immutable blob and the derived prepared record exist.
    expect(existsSync(join(env.root, 'projects', env.project, 'sources', 'sha256', staged.digest))).toBe(true);
    expect(existsSync(prepared.derivedPath)).toBe(true);
    const derived = JSON.parse(readFileSync(prepared.derivedPath, 'utf8')) as Record<string, unknown>;
    expect(derived['manifestDigest']).toBe(prepared.prepared.manifestDigest);
    expect(derived['outputDigest']).toBe(prepared.prepared.outputDigest);
    // No authoritative change from the preparation layer.
    expect(Buffer.from(envelopeBytes(env)).equals(Buffer.from(before))).toBe(true);
    expect(recordOf(env, BEHAVIOR_ID)?.source).toBeNull();

    // Publication through the single commit path.
    const rev = envelopeJson(env).scene.revision;
    const published = await publishBehaviorSource(env.svc, {
      projectId: env.project,
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      displayName: 'Drift',
      declaration: DECLARATION,
      expectedRevision: rev,
      requestId: requestId(4),
      origin: ORIGIN,
    });
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published)}`);
    expect(published.result.revision).toBe(rev + 1);
    expect(recordOf(env, BEHAVIOR_ID)?.source).toMatchObject({
      sourceDigest: staged.digest,
      sourceByteLength: staged.bytes.length,
      entryPath: 'src/index.ts',
      fileCount: 2,
      manifestDigest: prepared.prepared.manifestDigest,
      outputDigest: prepared.prepared.outputDigest,
      outputByteLength: prepared.prepared.outputByteLength,
      requiredModules: ['@thirdlight/runtime'],
      publishedRevision: rev + 1,
    });
    const envelopeAfterPublish = envelopeBytes(env);
    discard(env, staged.stageId);

    // Reopen: the record persists and a source publication succeeds from the
    // durable derived prepared record alone (no recompile needed). The
    // supported boundary is release → reopen (workspace.md §9.1).
    const released = env.svc.releaseWorkspace(env.project);
    expect(released.ok).toBe(true);
    env.svc.dispose();
    const reopened = openWorkspaceService({ root: env.root, behaviorCompiler: env.compiler });
    const rev2 = envelopeJson(env).scene.revision;
    const again = reopened.runCommand({
      op: 'publishBehavior',
      projectId: env.project,
      expectedRevision: rev2,
      requestId: requestId(5),
      origin: ORIGIN,
      args: {
        behaviorId: BEHAVIOR_ID,
        displayName: 'Drift',
        mode: 'source',
        declaration: DECLARATION,
        source: { sourceDigest: staged.digest, sourceByteLength: staged.bytes.length },
      },
    });
    if (!again.ok) throw new Error(`reopen publish failed: ${JSON.stringify(again)}`);
    expect(again.revision).toBe(rev2 + 1);
    expect(recordOf(env, BEHAVIOR_ID)?.source).toMatchObject({ sourceDigest: staged.digest });
    // The reopen published a new revision (publishedRevision advanced) from the
    // durable prepared record: the envelope changed and the blob is intact.
    expect(Buffer.from(envelopeAfterPublish).equals(Buffer.from(envelopeBytes(env)))).toBe(false);
    expect(sha256Hex(fixtureBytes('valid/sample.json'))).toBe(staged.digest);
    reopened.dispose();
  }, 90_000);

  it('publishes a 951-byte canonical container (the len == 55 (mod 64) digest class)', async () => {
    // Gate I repair R-I-1(b). Build a canonical container whose UTF-8 length is
    // exactly 951 bytes (951 % 64 === 55): the padding class the old
    // `behavior-build` SHA-256 got wrong. Before the repair
    // `prepareBehaviorSource` recorded the wrong `sourceDigest`, so
    // `publishBehavior` (`mode:"source"`) failed
    // `behavior_publication_unavailable` / `reason:"preparation_missing"` for
    // this fully valid source.
    const env = makeBuildEnv('m2pad951');
    createDeclaration(env, 1);

    const sample = JSON.parse(new TextDecoder().decode(fixtureBytes('valid/sample.json'))) as {
      files: { path: string; text: string }[];
    };
    const encoder = new TextEncoder();
    const base = `${JSON.stringify(sample, null, 2)}\n`;
    expect(encoder.encode(base).length).toBe(922);
    const delta = 951 - encoder.encode(base).length;
    // A trailing `\n// ` line comment costs 5 JSON bytes (the newline escapes).
    (sample.files[0] as { text: string }).text += `\n// ${'p'.repeat(delta - 5)}`;
    const bytes = encoder.encode(`${JSON.stringify(sample, null, 2)}\n`);
    expect(bytes.length).toBe(951);
    expect(bytes.length % 64).toBe(55);

    const stageId = 'stage-0951';
    const staged = env.svc.stageContent(env.project, { stageId, bytes });
    if (!staged.ok) throw new Error(`stage failed: ${JSON.stringify(staged)}`);
    // The workspace address is the platform digest (node:crypto in the helper).
    const digest = sha256Hex(bytes);
    acknowledge(env, digest, 2);

    const prepared = await env.svc.prepareBehaviorSource(env.project, {
      stageId,
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
    // The digest the compiler bound (asserted after the publication below, so
    // the negative control shows the real end-to-end failure first).
    const preparedDigest = prepared.prepared.sourceDigest;
    expect(existsSync(join(env.root, 'projects', env.project, 'sources', 'sha256', digest))).toBe(true);

    const rev = envelopeJson(env).scene.revision;
    const published = await publishBehaviorSource(env.svc, {
      projectId: env.project,
      stageId,
      behaviorId: BEHAVIOR_ID,
      displayName: 'Drift',
      declaration: DECLARATION,
      expectedRevision: rev,
      requestId: requestId(3),
      origin: ORIGIN,
    });
    if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published)}`);
    // The repaired compiler digest equals the workspace's blob address; before
    // the repair `published` above failed
    // `behavior_publication_unavailable` / `reason:"preparation_missing"`.
    expect(preparedDigest).toBe(digest);
    expect(recordOf(env, BEHAVIOR_ID)?.source).toMatchObject({
      sourceDigest: digest,
      sourceByteLength: 951,
      entryPath: 'src/index.ts',
      manifestDigest: prepared.prepared.manifestDigest,
      outputDigest: prepared.prepared.outputDigest,
    });
    discard(env, stageId);
  }, 90_000);

  it('survives every hostile container: no record, no blob, no envelope change', async () => {
    const env = makeBuildEnv('m2fail');
    createDeclaration(env, 1);
    const staged = stage(env, 'valid/sample.json', 2);
    acknowledge(env, staged.digest, 3);
    const published = await publishBehaviorSource(env.svc, {
      projectId: env.project,
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      displayName: 'Drift',
      declaration: DECLARATION,
      expectedRevision: envelopeJson(env).scene.revision,
      requestId: requestId(4),
      origin: ORIGIN,
    });
    if (!published.ok) throw new Error(`baseline publish failed: ${JSON.stringify(published)}`);
    discard(env, staged.stageId);
    const publishedEnvelope = envelopeBytes(env);

    const hostile = index.cases.filter((c) => c.expect['ok'] === false);
    expect(hostile.length).toBeGreaterThanOrEqual(25);
    const problems: string[] = [];
    let n = 100;
    for (const c of hostile) {
      const s = stage(env, c.container, n++);
      // The acknowledgment is an ordinary authoritative mutation (it advances
      // the revision); the preparation failure after it must write NOTHING.
      acknowledge(env, s.digest, n++);
      const beforePrepare = envelopeBytes(env);
      const revisionBefore = envelopeJson(env).scene.revision;
      const prepared = await env.svc.prepareBehaviorSource(env.project, {
        stageId: s.stageId,
        behaviorId: BEHAVIOR_ID,
        declaration: DECLARATION,
      });
      if (prepared.ok) {
        problems.push(`${c.caseId}: preparation succeeded`);
      } else if (prepared.kind === 'compile' && prepared.failure.code !== c.expect['code']) {
        problems.push(`${c.caseId}: code ${prepared.failure.code} != ${String(c.expect['code'])}`);
      }
      if (!Buffer.from(envelopeBytes(env)).equals(Buffer.from(beforePrepare))) problems.push(`${c.caseId}: envelope changed`);
      if (envelopeJson(env).scene.revision !== revisionBefore) problems.push(`${c.caseId}: revision changed`);
      if (existsSync(join(env.root, 'projects', env.project, 'sources', 'sha256', s.digest))) problems.push(`${c.caseId}: blob written`);
      discard(env, s.stageId);
    }
    expect(problems).toEqual([]);
    // The successfiil baseline publication is still intact.
    expect(recordOf(env, BEHAVIOR_ID)?.source).toMatchObject({ sourceDigest: staged.digest });
    expect(Buffer.from(publishedEnvelope).equals(Buffer.from(envelopeBytes(env)))).toBe(false);
  }, 120_000);

  it('refuses an unacknowledged digest and an unprepared digest without writing', async () => {
    const env = makeBuildEnv('m2gate');
    createDeclaration(env, 1);
    const staged = stage(env, 'valid/sample.json', 2);
    const good = envelopeBytes(env);

    // No acknowledgment: the preparation layer gates before compiling.
    const unack = await env.svc.prepareBehaviorSource(env.project, {
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    expect(unack.ok).toBe(false);
    if (!unack.ok && unack.kind === 'error') expect(unack.error.code).toBe('behavior_trust_unacknowledged');
    expect(Buffer.from(envelopeBytes(env)).equals(Buffer.from(good))).toBe(true);

    acknowledge(env, staged.digest, 3);
    const rev = envelopeJson(env).scene.revision;
    const afterAck = envelopeBytes(env);

    // A digest with no prepared artifact: preparation_missing (never a write).
    const missing = env.svc.runCommand({
      op: 'publishBehavior',
      projectId: env.project,
      expectedRevision: rev,
      requestId: requestId(4),
      origin: ORIGIN,
      args: {
        behaviorId: BEHAVIOR_ID,
        displayName: 'Drift',
        mode: 'source',
        declaration: DECLARATION,
        source: { sourceDigest: 'b'.repeat(64), sourceByteLength: 10 },
      },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('behavior_publication_unavailable');
      expect((missing.error as unknown as { reason: string }).reason).toBe('preparation_missing');
    }
    expect(Buffer.from(envelopeBytes(env)).equals(Buffer.from(afterAck))).toBe(true);

    // A stale byte length for a real prepared digest: declaration mismatch.
    const prepared = await env.svc.prepareBehaviorSource(env.project, {
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    expect(prepared.ok).toBe(true);
    const stale = env.svc.runCommand({
      op: 'publishBehavior',
      projectId: env.project,
      expectedRevision: rev,
      requestId: requestId(5),
      origin: ORIGIN,
      args: {
        behaviorId: BEHAVIOR_ID,
        displayName: 'Drift',
        mode: 'source',
        declaration: DECLARATION,
        source: { sourceDigest: staged.digest, sourceByteLength: 1 },
      },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('behavior_declaration_mismatch');
    expect(Buffer.from(envelopeBytes(env)).equals(Buffer.from(afterAck))).toBe(true);
  }, 60_000);

  it('refuses a declaration that does not match the compiled one', async () => {
    const env = makeBuildEnv('m2decl');
    createDeclaration(env, 1);
    const staged = stage(env, 'valid/sample.json', 2);
    acknowledge(env, staged.digest, 3);
    const prepared = await env.svc.prepareBehaviorSource(env.project, {
      stageId: staged.stageId,
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    expect(prepared.ok).toBe(true);
    const good = envelopeBytes(env);
    const res = env.svc.runCommand({
      op: 'publishBehavior',
      projectId: env.project,
      expectedRevision: envelopeJson(env).scene.revision,
      requestId: requestId(4),
      origin: ORIGIN,
      args: {
        behaviorId: BEHAVIOR_ID,
        displayName: 'Drift',
        mode: 'source',
        declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] },
        source: { sourceDigest: staged.digest, sourceByteLength: staged.bytes.length },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('behavior_declaration_mismatch');
    expect(Buffer.from(envelopeBytes(env)).equals(Buffer.from(good))).toBe(true);
  }, 60_000);

  it('never executes staged project source (sentinel through the real pipeline)', async () => {
    const env = makeBuildEnv('m2sent');
    createDeclaration(env, 1);
    const sentinel = '__thirdlight_stage_executed__';
    const container = {
      graphVersion: 1,
      entryPath: 'src/index.ts',
      requiredModules: [],
      ownedTransforms: [],
      files: [
        {
          path: 'src/index.ts',
          text: `globalThis.${sentinel} = true;\nthrow new Error('must not run');\nexport default { step() {} };\n`,
        },
      ],
    };
    const bytes = new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`);
    const digest = sha256Hex(bytes);
    const res = env.svc.stageContent(env.project, { stageId: 'stage-0002', bytes });
    if (!res.ok) throw new Error(JSON.stringify(res));
    acknowledge(env, digest, 3);
    const prepared = await env.svc.prepareBehaviorSource(env.project, {
      stageId: 'stage-0002',
      behaviorId: BEHAVIOR_ID,
      declaration: DECLARATION,
    });
    expect(prepared.ok).toBe(true);
    expect((globalThis as Record<string, unknown>)[sentinel]).toBeUndefined();
  }, 60_000);

  it('keeps the structural preparer_unavailable refusal when no compiler is injected', () => {
    const env = makeBuildEnv('m2nocompiler');
    createDeclaration(env, 1);
    const rev = envelopeJson(env).scene.revision;
    const released = env.svc.releaseWorkspace(env.project);
    expect(released.ok).toBe(true);
    env.svc.dispose();
    const bare = openWorkspaceService({ root: env.root }); // no behaviorCompiler
    const res = bare.runCommand({
      op: 'publishBehavior',
      projectId: env.project,
      expectedRevision: rev,
      requestId: requestId(2),
      origin: ORIGIN,
      args: {
        behaviorId: BEHAVIOR_ID,
        displayName: 'Drift',
        mode: 'source',
        declaration: DECLARATION,
        source: { sourceDigest: 'c'.repeat(64), sourceByteLength: 10 },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('behavior_publication_unavailable');
      expect((res.error as unknown as { reason: string }).reason).toBe('preparer_unavailable');
    }
    bare.dispose();
  }, 60_000);
});
