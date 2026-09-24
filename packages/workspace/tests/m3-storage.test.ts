/**
 * Durable project state on the real filesystem (workspace.md §16), ported to
 * storage v4 in phase 9.3 step B (the v3 single-envelope write path is gone;
 * the storage v3 originals are archived under archive/removed-v1-v2/workspace).
 *
 * - the committed packet-39 v3 envelope fixtures still load through the v3
 *   reader (the input of the v3 → v4 upgrade) in canonical form, and every
 *   invalid one is refused with its recorded code;
 * - a real game-config command writes content.json through `W` (the retry
 *   record in the same file), acks only after the durable write, and a
 *   lost-ack retry replays without a rewrite, also after a restart;
 * - the project files stay content.json + scenes/<id>.json + project.json (no
 *   `game.json`/`settings.json` side-car);
 * - a controlled write fault and an external change of content.json keep the
 *   accepted classification/refusal semantics;
 * - content reads over an upgraded v3 media project: typed prepared-media
 *   facts and copy-safe verified bytes.
 *
 * Related v4 coverage relied on (not duplicated here): scene-file retry
 * replay after a restart (dedup-retry.test.ts), scene-file write faults
 * (write-fault.test.ts), scene-file external changes (external-change.test.ts,
 * storage-v4.test.ts), the v3 → v4 upgrade on open (storage-v4.test.ts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateProjectV3 } from '@thirdlight/project-model';
import {
  defaultWriteOps,
  openWorkspaceService,
  type MutationResult,
  type WorkspaceService,
  type WriteOps,
} from '@thirdlight/workspace';

import { REPO_ROOT, fileBytes, makeRoot, seedProject, seedV3Project, sha256Hex } from './helpers';

const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const CREATED_AT = '2026-09-19T10:00:00Z';
const SELF = { backendId: 'tb-' + 'a'.repeat(32), pid: 6100 };
const COURIER_DIGEST = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';

function open(root: string, extra: Record<string, unknown> = {}): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT, ...extra });
}

/** The v3 Beacon Reach project (revision 3), upgraded to v4 when opened. */
function seedV3(root: string): string {
  return seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
}

function contentPath(root: string): string {
  return join(root, 'projects', PROJECT_ID, 'content.json');
}
function scenePath(root: string): string {
  return join(root, 'projects', PROJECT_ID, 'scenes', 'scene-main.json');
}

function editTitle(n: number, revision: number, title: string) {
  return {
    op: 'setGameConfig',
    projectId: PROJECT_ID,
    expectedRevision: revision,
    requestId: `req-${String(n).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { game: { title } },
  };
}

/** Open (claim + upgrade) the project and return its revision. */
function openedRevision(svc: WorkspaceService): number {
  const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
  expect(q.ok, JSON.stringify(q)).toBe(true);
  return q.revision;
}

describe('packet 46 — the v3 envelope reader (input of the v4 upgrade)', () => {
  it('loads every committed valid v3 envelope in canonical form', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    const dir = join(CONTRACTS, 'envelope', 'valid');
    const files = readdirSync(dir);
    expect(files.length).toBe(3);
    for (const f of files) {
      const bytes = fileBytes(join(dir, f));
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as { projectId: string };
      const res = validateEnvelope(bytes, raw.projectId);
      expect(res.ok, `${f}: ${JSON.stringify((res as { reason?: string }).reason)}`).toBe(true);
      if (!res.ok) continue;
      expect(res.storageVersion).toBe(3);
      // The normalized values re-serialize to the committed bytes (the
      // six-key v3 envelope layout).
      const rebuilt = JSON.stringify(
        { storageVersion: 3, type: 'authoring-state', projectId: raw.projectId, scene: res.scene, content: res.content, retry: { retention: 128, records: res.records } },
        null,
        2,
      ) + '\n';
      expect(rebuilt, f).toBe(new TextDecoder().decode(bytes));
    }
  });

  it('refuses every committed invalid v3 envelope with its recorded code', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    const idx = JSON.parse(readFileSync(join(CONTRACTS, 'index.json'), 'utf8')) as {
      fixtures: Record<string, { expect: { result?: string } }>;
    };
    const dir = join(CONTRACTS, 'envelope', 'invalid');
    const files = readdirSync(dir);
    expect(files.length).toBe(21);
    for (const f of files) {
      const bytes = fileBytes(join(dir, f));
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
        projectId?: string;
        scene?: { sceneId?: string };
      };
      const pid = raw.projectId ?? PROJECT_ID;
      const recorded = idx.fixtures[`envelope/invalid/${f}`]?.expect.result;
      expect(recorded, f).toBeDefined();
      // Phase 9.3: a storageVersion 2 envelope is refused as
      // storage_version_unsupported before the §16.2 combination check (the
      // v2 reader is gone), so the scene-3/storage-2 combination fixture now
      // stops at the storage version. The fixture bytes are unchanged.
      const want = f === 'combination-scene3-storage2.json' ? 'storage_version_unsupported' : recorded;
      const env = validateEnvelope(bytes, pid);
      if (env.ok) {
        // A cross-block failure needs the manifest holder (the session path).
        const manifest = {
          schemaVersion: 1 as const,
          engineVersion: '0.1.0',
          id: pid,
          name: 'x',
          createdAt: CREATED_AT,
          scenes: [{ id: raw.scene?.sceneId ?? 'scene-main', path: 'scenes/main.json' }],
        };
        const proj = validateProjectV3(manifest, env.scene, env.content);
        expect(proj.ok, `${f} should fail cross-block`).toBe(false);
        if (!proj.ok) expect(proj.errors[0]?.code, f).toBe(want);
      } else {
        expect([env.reason, env.errors[0]?.code], f).toContain(want);
      }
    }
  });

  it('refuses a v3 project whose cross-block game/cue references dangle at open', () => {
    const root = makeRoot('m3store-cross');
    // A committed invalid v3 envelope (a dangling game cue) in a real project
    // layout: the session loader's §16.4 step-5 cross-block check must refuse.
    const dir = seedV3Project(root, PROJECT_ID, fileBytes(join(CONTRACTS, 'envelope', 'invalid', 'cue-unresolved.json')));
    const before = fileBytes(join(dir, 'scenes', 'main.json'));
    const svc = open(root, SELF);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as {
      ok: boolean;
      error?: { reason?: string };
    };
    expect(q.ok).toBe(false);
    expect(q.error?.reason).toBe('asset_reference_missing');
    // Refused, not upgraded: the v3 envelope is untouched and no v4 file appeared.
    expect(Buffer.compare(Buffer.from(before), readFileSync(join(dir, 'scenes', 'main.json')))).toBe(0);
    expect(existsSync(join(dir, 'content.json'))).toBe(false);
    svc.dispose();
  });

  it('reports the combination/storage/game-budget refusals as the workspace reason', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    const read = (f: string): Uint8Array => fileBytes(join(CONTRACTS, 'envelope', 'invalid', f));
    const combo = validateEnvelope(read('combination-scene2-storage3.json'), PROJECT_ID);
    expect(combo.ok).toBe(false);
    if (!combo.ok) expect(combo.reason).toBe('version_combination_unsupported');
    const unknown = validateEnvelope(read('storage-unknown-4.json'), PROJECT_ID);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('storage_version_unsupported');
    const scene = validateEnvelope(read('zone-parented.json'), PROJECT_ID);
    expect(scene.ok).toBe(false);
    if (!scene.ok) expect(scene.reason).toBe('scene_invalid');
    const content = validateEnvelope(read('game-extra-field.json'), PROJECT_ID);
    expect(content.ok).toBe(false);
    if (!content.ok) expect(content.reason).toBe('content_invalid');
  });
});

describe('durable content.json write (workspace.md §5.3; storage v4)', () => {
  it('acks a game-config edit only after the durable content.json write, and replays a lost-ack retry', () => {
    const root = makeRoot('m3store-write');
    seedV3(root);
    const svc = open(root, SELF);
    expect(openedRevision(svc)).toBe(3);
    const sceneBefore = readFileSync(scenePath(root));

    const r = svc.runCommand(editTitle(1, 3, 'Beacon Reach II')) as MutationResult;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.revision).toBe(4);
    expect(r.duplicated).toBe(false);

    // The acked state is durable and canonical: the v4 content file carries
    // the new game config and the retry record; the scene file is not written
    // (only the files a transaction changes are written).
    const onDisk = JSON.parse(readFileSync(contentPath(root), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual(['storageVersion', 'type', 'projectId', 'revision', 'content', 'retry']);
    expect(onDisk['storageVersion']).toBe(4);
    expect(onDisk['type']).toBe('project-content');
    expect(onDisk['revision']).toBe(4);
    const retry = onDisk['retry'] as { records: { requestId: string; appliedRevision: number }[] };
    expect(retry.records.length).toBe(1);
    expect(retry.records[0]!.requestId).toBe('req-' + String(1).padStart(32, '0'));
    expect(retry.records[0]!.appliedRevision).toBe(4);
    expect((onDisk['content'] as { game: { title: string } }).game.title).toBe('Beacon Reach II');
    expect(Buffer.compare(sceneBefore, readFileSync(scenePath(root)))).toBe(0);

    // A lost-ack retry with the same requestId replays durably (no rewrite).
    const before = readFileSync(contentPath(root));
    const again = svc.runCommand(editTitle(1, 3, 'Beacon Reach II')) as MutationResult;
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.duplicated).toBe(true);
      expect(again.revision).toBe(4);
    }
    expect(Buffer.compare(before, readFileSync(contentPath(root)))).toBe(0);

    // A fresh open (same backend identity) loads the state, and the durable
    // record in content.json still answers the retry.
    svc.dispose();
    const svc2 = open(root, SELF);
    expect(openedRevision(svc2)).toBe(4);
    const replay = svc2.runCommand(editTitle(1, 3, 'Beacon Reach II')) as MutationResult;
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.duplicated).toBe(true);
      expect(replay.revision).toBe(4);
    }
    expect(Buffer.compare(before, readFileSync(contentPath(root)))).toBe(0);
    svc2.dispose();
  });

  it('keeps the v4 project files the only mutable authoritative files (no side-car)', () => {
    const root = makeRoot('m3store-sidecar');
    seedV3(root);
    const svc = open(root, SELF);
    const r = svc.runCommand(editTitle(2, 3, 'One File')) as MutationResult;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const dir = join(root, 'projects', PROJECT_ID);
    for (const rel of ['game.json', 'settings.json', 'scene.json', join('scenes', 'main.json')]) {
      expect(existsSync(join(dir, rel)), rel).toBe(false);
    }
    expect(readdirSync(dir).sort()).toEqual(['.thirdlight', 'content.json', 'project.json', 'scenes']);
    expect(readdirSync(join(dir, 'scenes'))).toEqual(['scene-main.json']);
    svc.dispose();
  });

  it('classifies a controlled write fault as write_failed{previous} and leaves content.json unchanged', () => {
    const root = makeRoot('m3store-fault');
    seedV3(root);
    // Healthy open first (claim + upgrade), then a faulted same-identity service.
    const healthy = open(root, SELF);
    expect(openedRevision(healthy)).toBe(3);
    healthy.dispose();
    const before = readFileSync(contentPath(root));
    const faulty: WriteOps = {
      ...defaultWriteOps,
      writeAll: () => {
        const e = new Error('injected EIO') as Error & { errno?: string };
        e.errno = 'EIO';
        throw e;
      },
    };
    const svc = open(root, { ...SELF, ops: faulty });
    const r = svc.runCommand(editTitle(3, 3, 'Faulted')) as MutationResult;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('write_failed');
      expect((r.error as { onDiskState?: string }).onDiskState).toBe('previous');
    }
    expect(Buffer.compare(before, readFileSync(contentPath(root)))).toBe(0);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    svc.dispose();
  });

  it('pauses on an external content.json modification and accepts the operator resolution', () => {
    const root = makeRoot('m3store-ext');
    seedV3(root);
    const svc = open(root, SELF);
    // Load the project first (the external-change protocol is about a change
    // AFTER this backend loaded the state, workspace.md §5.2/§7.2).
    expect(openedRevision(svc)).toBe(3);
    const foreign = JSON.parse(readFileSync(contentPath(root), 'utf8')) as {
      content: { game: { title: string } };
    };
    foreign.content.game.title = 'Hand edited';
    writeFileSync(contentPath(root), JSON.stringify(foreign, null, 2) + '\n');

    const r = svc.runCommand(editTitle(4, 3, 'Nope')) as MutationResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('external_change_unresolved');
    const acc = svc.acceptExternalState(PROJECT_ID);
    expect(acc.ok, JSON.stringify(acc)).toBe(true);
    const g = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID }) as { ok: boolean; game: { title: string } };
    expect(g.ok).toBe(true);
    expect(g.game.title).toBe('Hand edited');
    const onDisk = JSON.parse(readFileSync(contentPath(root), 'utf8')) as { content: { game: { title: string } }; retry: { records: unknown[] } };
    expect(onDisk.content.game.title).toBe('Hand edited');
    expect(onDisk.retry.records).toEqual([]);
    // Editing continues from the accepted state.
    const rev = openedRevision(svc);
    const next = svc.runCommand(editTitle(5, rev, 'After accept')) as MutationResult;
    expect(next.ok, JSON.stringify(next)).toBe(true);
    svc.dispose();
  });

  it('discards an external content.json modification back to the last known good bytes', () => {
    const root = makeRoot('m3store-ext-discard');
    seedV3(root);
    const svc = open(root, SELF);
    expect(openedRevision(svc)).toBe(3);
    const lkg = readFileSync(contentPath(root));
    const foreign = JSON.parse(lkg.toString('utf8')) as { content: { game: { title: string } } };
    foreign.content.game.title = 'Hand edited';
    writeFileSync(contentPath(root), JSON.stringify(foreign, null, 2) + '\n');
    const r = svc.runCommand(editTitle(6, 3, 'Nope')) as MutationResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('external_change_unresolved');
    const disc = svc.discardExternalState(PROJECT_ID);
    expect(disc.ok, JSON.stringify(disc)).toBe(true);
    if (disc.ok) expect(disc.revision).toBe(3);
    expect(Buffer.compare(lkg, readFileSync(contentPath(root)))).toBe(0);
    const g = svc.query({ op: 'queryGameConfig', projectId: PROJECT_ID }) as { ok: boolean; game: { title: string } };
    expect(g.game.title).toBe('Beacon Reach');
    svc.dispose();
  });
});

describe('packet 46 — content reads over an upgraded v3 media project (workspace.md §16.6)', () => {
  it('reports typed prepared-media facts and returns copy-safe verified bytes', async () => {
    const { preparedMediaFacts } = await import('../src/content-store');
    const root = makeRoot('m3store-facts');
    // The committed v3 media project (a model and an audio asset) with its
    // source blobs; it is upgraded to v4 on open.
    const dir = seedV3Project(root, PROJECT_ID, fileBytes(join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json')));
    mkdirSync(join(dir, 'sources', 'sha256'), { recursive: true });
    const courier = fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb'));
    const wav = fileBytes(join(CONTRACTS, 'source-preimages', 'cue-start.wav'));
    expect(sha256Hex(courier)).toBe(COURIER_DIGEST);
    writeFileSync(join(dir, 'sources', 'sha256', COURIER_DIGEST), courier);
    writeFileSync(join(dir, 'sources', 'sha256', sha256Hex(wav)), wav);
    const svc = open(root, SELF);
    expect(openedRevision(svc)).toBe(5);
    expect(existsSync(join(dir, 'content.json'))).toBe(true);

    const integrity = svc.contentIntegrity(PROJECT_ID);
    expect(integrity.ok, JSON.stringify(integrity)).toBe(true);
    if (integrity.ok) expect(integrity.summary).toMatchObject({ total: 2, ok: 2, missing: 0, corrupt: 0, orphanBlobs: 0 });
    const read = svc.readBlob(PROJECT_ID, { assetId: 'asset-model-courier', version: 1 });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (read.ok) {
      expect(read.verified).toBe(true);
      expect(sha256Hex(read.bytes)).toBe(COURIER_DIGEST);
      expect(read.byteLength).toBe(47);
      // The returned bytes are an independent copy: mutating them cannot
      // change a later read (copy-safe immutable byte read).
      read.bytes[0] = 0;
    }
    const read2 = svc.readBlob(PROJECT_ID, { assetId: 'asset-model-courier', version: 1 });
    expect(read2.ok).toBe(true);
    if (read2.ok) expect(read2.bytes[0]).toBe(courier[0]);

    // The typed prepared-media facts over the upgraded (v4) catalog.
    const doc = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')) as { revision: number; content: never };
    const ctx = {
      projectId: PROJECT_ID,
      dir,
      thirdlightDir: join(dir, '.thirdlight'),
      storageVersion: 4 as const,
      revision: doc.revision,
      scene: null,
      content: doc.content,
    };
    const facts = preparedMediaFacts(ctx, 'asset-model-courier', 1);
    expect(facts.ok, JSON.stringify(facts)).toBe(true);
    if (facts.ok) {
      expect(facts.facts.kind).toBe('model');
      expect(facts.facts.sourceDigest).toBe(COURIER_DIGEST);
      expect(facts.facts.sourceByteLength).toBe(47);
      expect(facts.facts.importRecipe.profile).toBe('gltf-glb');
    }
    const missing = preparedMediaFacts(ctx, 'asset-model-courier', 9);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('asset_version_not_found');
    const audio = preparedMediaFacts(ctx, 'asset-audio-cue-start', 1);
    expect(audio.ok, JSON.stringify(audio)).toBe(true);
    if (audio.ok) expect(audio.facts.kind).toBe('audio');
    svc.dispose();
  });
});
