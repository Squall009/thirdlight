/**
 * Packet 46 — the v2→v3 copy operator on the real filesystem
 * (workspace.md §16.5/§16.8).
 *
 * The committed packet-39 migration fixtures are executed through the real
 * operator: `migration/v2-source` is opened read-only, copied, and the
 * destination is compared byte-for-byte against
 * `migration/expected-v3-destination`; `migration/interrupted-copy` resumes from
 * its recorded phase. Every source file is hashed before and after both a
 * successful and a refused migration.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  defaultWriteOps,
  openWorkspaceService,
  type WorkspaceService,
} from '@thirdlight/workspace';

import { REPO_ROOT, buildFakeProc, fileBytes, makeRoot, seedProject, sha256Hex } from './helpers';

const MIGRATION = join(REPO_ROOT, 'fixtures', 'm3', 'contracts', 'migration');
const PREIMAGES = join(REPO_ROOT, 'fixtures', 'm3', 'contracts', 'source-preimages');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const SOURCE = 'demo-0002';
const DEST = 'demo-0003';
const CREATED_AT = '2026-09-19T10:00:00Z';
const COURIER_DIGEST = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';

function hashTree(dir: string): string {
  const walk = (d: string): string[] => {
    const out: string[] = [];
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  return walk(dir)
    .map((p) => `${p.slice(dir.length + 1)}:${sha256Hex(fileBytes(p))}`)
    .join('\n');
}

function open(root: string, extra: Record<string, unknown> = {}): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT, ...extra });
}

/** Seed the v2 source project from the committed packet-39 `migration/v2-source`
 * fixture (the §16.5.1 precondition input) plus its one content-addressed
 * blob. The fixture is a flat pair of files, so the project layout is written
 * explicitly. CC-46-1 repair (2026-09-19): the fixture's retry stub was
 * removed so the document really is v2-pipeline-loadable, exactly as §16.5.1
 * requires and as `fixtures/m3/contracts/tools/check-fixtures.mjs` group 4 now
 * asserts. */
function seedSource(root: string): string {
  const dir = join(root, 'projects', SOURCE);
  mkdirSync(join(dir, 'scenes'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), fileBytes(join(MIGRATION, 'v2-source', 'project.json')));
  writeFileSync(join(dir, 'scenes', 'main.json'), fileBytes(join(MIGRATION, 'v2-source', 'envelope.json')));
  mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
  writeFileSync(join(dir, 'sources', 'sha256', COURIER_DIGEST), fileBytes(join(PREIMAGES, 'courier.glb')));
  return dir;
}

describe('packet 46 — migrateProjectCopyV3 (workspace.md §16.5)', () => {
  it('copies a v2 source to a new v3 project byte-identical to the fixture, source untouched', () => {
    const root = makeRoot('m3mig');
    const sourceDir = seedSource(root);
    const before = hashTree(sourceDir);

    const svc = open(root);
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    if (!res.ok) throw new Error('migration failed: ' + JSON.stringify(res));
    expect(res.sourceVersion).toBe(2);
    expect(res.newVersion).toBe(3);
    expect(res.sourceRevision).toBe(6);
    expect(res.newRevision).toBe(0);
    expect(res.revisionPolicy).toBe('reset-to-zero');
    expect(res.historyReset).toBe(true);
    expect(res.retryCleared).toBe(true);
    expect(res.blobsCopied).toBe(1);
    expect(res.blobsAlreadyPresent).toBe(0);
    expect(res.resumed).toBe(false);

    // The destination equals the accepted expected-v3-destination fixture.
    const destDir = join(root, 'projects', DEST);
    expect(Array.from(fileBytes(join(destDir, 'project.json')))).toEqual(
      Array.from(fileBytes(join(MIGRATION, 'expected-v3-destination', 'project.json'))),
    );
    expect(Array.from(fileBytes(join(destDir, 'scenes', 'main.json')))).toEqual(
      Array.from(fileBytes(join(MIGRATION, 'expected-v3-destination', 'envelope.json'))),
    );
    // The copied blob is present and verified.
    expect(sha256Hex(fileBytes(join(destDir, 'sources', 'sha256', COURIER_DIGEST)))).toBe(COURIER_DIGEST);
    // The marker is removed and the destination loads as a v3 project.
    expect(existsSync(join(destDir, '.thirdlight', 'migration.json'))).toBe(false);
    const q = svc.query({ op: 'queryProject', projectId: DEST }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(0);
    // The captured v3 view resolves the copy's reset publishedRevision.
    const view = svc.captureContentView(DEST);
    expect(view.ok).toBe(true);

    // The source is byte-identical and was never written.
    expect(hashTree(sourceDir)).toBe(before);

    // A second migration to the same (now loadable) destination refuses
    // without writing; the source stays byte-identical.
    const again = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('migration_destination_exists');
    expect(hashTree(sourceDir)).toBe(before);
    svc.dispose();
  });

  it('clears a non-empty source retry block instead of carrying it into the copy', () => {
    // Non-vacuity for §16.5.2's `retryCleared`: make the source carry a real
    // durable retry record (written by the same `W` through the real engine)
    // before the copy, then prove the destination starts with an empty block.
    // The source is left stale-owned (backend A 'crashed' in the fake /proc),
    // so backend B may read it without the operator releasing it (release
    // would clear the records, §9.1 — which is exactly what this test must not
    // rely on).
    const root = makeRoot('m3mig-retry');
    seedSource(root);
    const procRoot = buildFakeProc(root, {});
    const a = open(root, { procRoot, pid: 6000 });
    const q = a.query({ op: 'queryProject', projectId: SOURCE }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    const moved = a.runCommand({
      op: 'setTransform',
      projectId: SOURCE,
      expectedRevision: q.revision,
      requestId: 'req-' + '5'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi-mig' },
      args: { entityId: 'box-0001', transform: { position: [9, -0.2, 0] } },
    }) as { ok: boolean };
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const srcEnv = JSON.parse(readFileSync(join(root, 'projects', SOURCE, 'scenes', 'main.json'), 'utf8')) as {
      retry: { records: unknown[] };
    };
    expect(srcEnv.retry.records.length).toBeGreaterThan(0);
    a.dispose();

    const b = open(root, { procRoot, pid: 6001 });
    const res = b.migrateProjectCopyV3(SOURCE, 'demo-retry-dst');
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.retryCleared).toBe(true);
    const destEnv = JSON.parse(
      readFileSync(join(root, 'projects', 'demo-retry-dst', 'scenes', 'main.json'), 'utf8'),
    ) as { retry: { retention: number; records: unknown[] }; scene: { revision: number }; content: { game: unknown } };
    expect(destEnv.retry.records).toEqual([]);
    expect(destEnv.retry.retention).toBe(128);
    expect(destEnv.scene.revision).toBe(0);
    expect(destEnv.content.game).toBeNull();
    b.dispose();
  });

  it('migrates a source that carries a prepared behavior record (GR-L-1)', () => {
    // workspace.md §16.5.2 resets every `content.behaviors[i].source
    // .publishedRevision` to 0 for the new identity, and project-model §12
    // step 5 / §22.2 rule 4 read that bound as `>= 0` for a copy-written
    // record. The source below really carries a prepared behavior source
    // (publishedRevision 4 >= 1) so the copied 0 is genuinely exercised — no
    // committed M3 fixture has a non-empty `content.behaviors`.
    const root = makeRoot('m3mig-beh');
    const sourceDir = seedSource(root);
    const envPath = join(sourceDir, 'scenes', 'main.json');
    const env = JSON.parse(readFileSync(envPath, 'utf8')) as { content: { behaviors: unknown[] } };
    const compiled = JSON.parse(
      readFileSync(join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'behaviors', 'compiled-example.json'), 'utf8'),
    ) as { record: unknown };
    env.content.behaviors = [compiled.record];
    writeFileSync(envPath, JSON.stringify(env, null, 2) + '\n');
    // The prepared behavior container the record references
    // (`fixtures/m2/contracts/behaviors/source-preimages/drift-example.json`).
    const containerFile = 'drift-example.json';
    const container = fileBytes(
      join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'behaviors', 'source-preimages', containerFile),
    );
    const containerDigest = sha256Hex(container);
    writeFileSync(join(sourceDir, 'sources', 'sha256', containerDigest), container);

    const svc = open(root);
    const q = svc.query({ op: 'queryProject', projectId: SOURCE }) as { ok: boolean };
    expect(q.ok).toBe(true);
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;

    const destEnv = JSON.parse(
      readFileSync(join(root, 'projects', DEST, 'scenes', 'main.json'), 'utf8'),
    ) as { content: { behaviors: { publishedRevision: number; source: { publishedRevision: number } }[] } };
    expect(destEnv.content.behaviors[0]!.publishedRevision).toBe(0);
    expect(destEnv.content.behaviors[0]!.source.publishedRevision).toBe(0);
    // The destination is loadable and the behavior container blob was copied.
    const q2 = svc.query({ op: 'queryProject', projectId: DEST }) as { ok: boolean };
    expect(q2.ok).toBe(true);
    expect(existsSync(join(root, 'projects', DEST, 'sources', 'sha256', containerDigest))).toBe(true);
    svc.dispose();
  });

  it('refuses a v1 source and a v3 source with migration_version_unsupported, writing nothing', () => {
    const root = makeRoot('m3mig-ver');
    seedProject(root, join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'migration', 'v1-source'), 'demo-m1');
    const v1Dir = join(root, 'projects', 'demo-m1');
    const v1Before = hashTree(v1Dir);
    const svc = open(root);
    const r1 = svc.migrateProjectCopyV3('demo-m1', 'demo-new-01');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.code).toBe('migration_version_unsupported');
      expect((r1.error as { foundVersion?: unknown }).foundVersion).toBe(1);
      expect((r1.error as { expectedVersion?: unknown }).expectedVersion).toBe('2');
    }
    expect(hashTree(v1Dir)).toBe(v1Before);
    expect(existsSync(join(root, 'projects', 'demo-new-01'))).toBe(false);

    // A v3 source is already the destination version.
    seedProject(root, join(STORAGE, 'project-v3-demo-0003'), DEST);
    const r2 = svc.migrateProjectCopyV3(DEST, 'demo-new-02');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('migration_version_unsupported');
    expect(existsSync(join(root, 'projects', 'demo-new-02'))).toBe(false);
    svc.dispose();
  });

  it('refuses a source owned by a live backend without writing either tree', () => {
    const root = makeRoot('m3mig-owned');
    const sourceDir = seedSource(root);
    const thirdlight = join(sourceDir, '.thirdlight');
    mkdirSync(thirdlight, { recursive: true });
    const procRoot = buildFakeProc(root, { 4242: 'live' }, 'thirdlight', '2026-09-17T09:00:00Z');
    writeFileSync(
      join(thirdlight, 'ownership.json'),
      JSON.stringify(
        {
          storageVersion: 1,
          state: 'owned',
          backendId: 'tb-' + '1'.repeat(32),
          pid: 4242,
          openedAt: '2026-09-17T09:00:00Z',
          lockEpoch: 0,
        },
        null,
        2,
      ) + '\n',
    );
    const before = hashTree(sourceDir);
    const svc = open(root, { procRoot });
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('migration_source_invalid');
    expect(hashTree(sourceDir)).toBe(before);
    expect(existsSync(join(root, 'projects', DEST))).toBe(false);
    svc.dispose();
  });

  it('refuses a source blob that does not match its digest (source tamper)', () => {
    const root = makeRoot('m3mig-tamper');
    const sourceDir = seedSource(root);
    writeFileSync(join(sourceDir, 'sources', 'sha256', COURIER_DIGEST), Buffer.from('tampered bytes'));
    const svc = open(root);
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('migration_source_invalid');
      const details = (res.error as { details?: readonly { code: string }[] }).details ?? [];
      expect(details.some((d) => d.code === 'blob_corrupt')).toBe(true);
    }
    // The destination is resumable (never authoritative); the source is as-is.
    expect(existsSync(join(root, 'projects', DEST, 'scenes', 'main.json'))).toBe(false);
    svc.dispose();
  });

  it('refuses a missing source-referenced blob before any write', () => {
    const root = makeRoot('m3mig-missing');
    const sourceDir = seedSource(root);
    rmSync(join(sourceDir, 'sources', 'sha256', COURIER_DIGEST));
    const before = hashTree(sourceDir);
    const svc = open(root);
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('migration_source_invalid');
      const details = (res.error as { details?: readonly { code: string }[] }).details ?? [];
      expect(details.some((d) => d.code === 'blob_missing')).toBe(true);
    }
    // Nothing was written: the refusal precedes the first destination write.
    expect(existsSync(join(root, 'projects', DEST))).toBe(false);
    expect(hashTree(sourceDir)).toBe(before);
    svc.dispose();
  });

  it('resumes an interrupted destination from every marker phase, idempotently', () => {
    for (const phase of ['created', 'manifest', 'blobs', 'envelope'] as const) {
      const root = makeRoot(`m3mig-resume-${phase}`);
      seedSource(root);
      const destDir = join(root, 'projects', DEST);
      mkdirSync(join(destDir, '.thirdlight'), { recursive: true });
      writeFileSync(
        join(destDir, '.thirdlight', 'migration.json'),
        JSON.stringify(
          {
            storageVersion: 3,
            type: 'migration-copy',
            sourceProjectId: SOURCE,
            newProjectId: DEST,
            sourceVersion: 2,
            newVersion: 3,
            phase,
            startedAt: CREATED_AT,
          },
          null,
          2,
        ) + '\n',
      );
      if (phase !== 'created') {
        writeFileSync(
          join(destDir, 'project.json'),
          fileBytes(join(MIGRATION, 'expected-v3-destination', 'project.json')),
        );
      }
      if (phase === 'blobs' || phase === 'envelope') {
        mkdirSync(join(destDir, 'sources', 'sha256'), { recursive: true });
        writeFileSync(
          join(destDir, 'sources', 'sha256', COURIER_DIGEST),
          fileBytes(join(PREIMAGES, 'courier.glb')),
        );
      }
      if (phase === 'envelope') {
        mkdirSync(join(destDir, 'scenes'), { recursive: true });
        writeFileSync(
          join(destDir, 'scenes', 'main.json'),
          fileBytes(join(MIGRATION, 'expected-v3-destination', 'envelope.json')),
        );
      }
      const svc = open(root);
      const res = svc.migrateProjectCopyV3(SOURCE, DEST);
      expect(res.ok, `${phase}: ${JSON.stringify(res)}`).toBe(true);
      if (!res.ok) continue;
      expect(res.resumed, phase).toBe(true);
      expect(res.blobsCopied, phase).toBe(phase === 'created' || phase === 'manifest' ? 1 : 0);
      expect(res.blobsAlreadyPresent, phase).toBe(phase === 'blobs' || phase === 'envelope' ? 1 : 0);
      expect(Array.from(fileBytes(join(destDir, 'scenes', 'main.json'))), phase).toEqual(
        Array.from(fileBytes(join(MIGRATION, 'expected-v3-destination', 'envelope.json'))),
      );
      expect(existsSync(join(destDir, '.thirdlight', 'migration.json')), phase).toBe(false);
      svc.dispose();
    }
  });

  it('a phase:created destination with an unexpected non-marker file refuses; a temp file is cleaned', () => {
    const root = makeRoot('m3mig-created');
    seedSource(root);
    const destDir = join(root, 'projects', DEST);
    mkdirSync(join(destDir, '.thirdlight'), { recursive: true });
    mkdirSync(join(destDir, 'scenes'), { recursive: true });
    writeFileSync(
      join(destDir, '.thirdlight', 'migration.json'),
      JSON.stringify(
        {
          storageVersion: 3,
          type: 'migration-copy',
          sourceProjectId: SOURCE,
          newProjectId: DEST,
          sourceVersion: 2,
          newVersion: 3,
          phase: 'created',
          startedAt: CREATED_AT,
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(destDir, 'scenes', '.main.json.tmp-4242-abc'), 'leftover');
    const svc = open(root);
    // The temp file alone is cleaned, not treated as an unexpected file.
    const ok = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    svc.dispose();

    // Now a real unexpected file (not a temp) refuses.
    const root2 = makeRoot('m3mig-created2');
    seedSource(root2);
    const dest2 = join(root2, 'projects', DEST);
    mkdirSync(join(dest2, '.thirdlight'), { recursive: true });
    writeFileSync(
      join(dest2, '.thirdlight', 'migration.json'),
      JSON.stringify(
        {
          storageVersion: 3,
          type: 'migration-copy',
          sourceProjectId: SOURCE,
          newProjectId: DEST,
          sourceVersion: 2,
          newVersion: 3,
          phase: 'created',
          startedAt: CREATED_AT,
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(join(dest2, 'operator-notes.txt'), 'do not touch');
    const svc2 = open(root2);
    const refused = svc2.migrateProjectCopyV3(SOURCE, DEST);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('migration_destination_exists');
    expect(readFileSync(join(dest2, 'operator-notes.txt'), 'utf8')).toBe('do not touch');
    expect(existsSync(join(dest2, 'scenes', 'main.json'))).toBe(false);
    svc2.dispose();
  });

  it('refuses a marker that names a different source or a v1 marker', () => {
    const root = makeRoot('m3mig-conflict');
    seedSource(root);
    const destDir = join(root, 'projects', DEST);
    mkdirSync(join(destDir, '.thirdlight'), { recursive: true });
    writeFileSync(
      join(destDir, '.thirdlight', 'migration.json'),
      JSON.stringify(
        {
          storageVersion: 3,
          type: 'migration-copy',
          sourceProjectId: 'demo-other',
          newProjectId: DEST,
          sourceVersion: 2,
          newVersion: 3,
          phase: 'manifest',
          startedAt: CREATED_AT,
        },
        null,
        2,
      ) + '\n',
    );
    const svc = open(root);
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('migration_marker_conflict');
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(false);
    svc.dispose();
  });

  it('reports an interrupted v3 destination in the startup scan and never auto-completes it', () => {
    const root = makeRoot('m3mig-scan');
    seedSource(root);
    const destDir = join(root, 'projects', DEST);
    mkdirSync(join(destDir, '.thirdlight'), { recursive: true });
    writeFileSync(
      join(destDir, '.thirdlight', 'migration.json'),
      JSON.stringify(
        {
          storageVersion: 3,
          type: 'migration-copy',
          sourceProjectId: SOURCE,
          newProjectId: DEST,
          sourceVersion: 2,
          newVersion: 3,
          phase: 'created',
          startedAt: CREATED_AT,
        },
        null,
        2,
      ) + '\n',
    );
    const svc = open(root);
    const entry = svc.scan().entries.find((e) => e.projectId === DEST);
    expect(entry).toBeDefined();
    expect(entry!.migration).toBe('resume_required');
    expect(entry!.code).toBe('migration_resume_required');
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(false);
    const resumed = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (resumed.ok) expect(resumed.resumed).toBe(true);
    expect(existsSync(join(destDir, 'scenes', 'main.json'))).toBe(true);
    svc.dispose();
  });

  it('rejects a malformed destination id with path_rejected', () => {
    const root = makeRoot('m3mig-badid');
    seedSource(root);
    const svc = open(root);
    const res = svc.migrateProjectCopyV3(SOURCE, '../escape');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('path_rejected');
    svc.dispose();
  });

  it('fails a write fault in the destination copy with content_publish_failed', () => {
    const root = makeRoot('m3mig-fault');
    seedSource(root);
    const faulty = {
      ...defaultWriteOps,
      openTempFile: () => {
        const e = new Error('injected EACCES') as Error & { errno?: string };
        e.errno = 'EACCES';
        throw e;
      },
    } as typeof defaultWriteOps;
    const svc = open(root, { ops: faulty });
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('content_publish_failed');
    // The destination was never made authoritative (no envelope).
    expect(existsSync(join(root, 'projects', DEST, 'scenes', 'main.json'))).toBe(false);
    svc.dispose();
  });

  it('fails the 120 s migration bound with content_publish_failed (timeout)', () => {
    const root = makeRoot('m3mig-timeout');
    seedSource(root);
    let calls = 0;
    const svc = open(root, { now: () => (calls++ === 0 ? 0 : 10_000_000) });
    const res = svc.migrateProjectCopyV3(SOURCE, DEST);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('content_publish_failed');
      expect((res.error as { reason?: string }).reason).toBe('timeout');
    }
    expect(existsSync(join(root, 'projects', DEST, 'scenes', 'main.json'))).toBe(false);
    svc.dispose();
  });
});
