/**
 * Packet 46 — durable v3 state on the real filesystem (workspace.md §16).
 *
 * - the committed packet-39 v3 envelope fixtures load through the workspace
 *   v3 branch (§16.4) and rebuild byte-identically;
 * - a real v3 command writes the six-key v3 envelope through the same `W` and
 *   the same ack timing as v2 (§5.3), and a lost-ack retry replays;
 * - the v3 envelope stays the ONLY mutable authoritative file (no `game.json`/
 *   `settings.json` side-car);
 * - a controlled write fault and an external change keep the accepted
 *   classification/refusal semantics for v3.
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
import { buildEnvelopeBytesV3 } from '../src/envelope';

import { REPO_ROOT, fileBytes, makeRoot, seedProject, sha256Hex } from './helpers';

const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');
const STORAGE = join(REPO_ROOT, 'fixtures', 'm3', 'storage');
const PROJECT_ID = 'demo-0003';
const CREATED_AT = '2026-09-19T10:00:00Z';
const SELF = { backendId: 'tb-' + 'a'.repeat(32), pid: 6100 };

function open(root: string, extra: Record<string, unknown> = {}): WorkspaceService {
  return openWorkspaceService({ root, utcNow: () => CREATED_AT, ...extra });
}

function seedV3(root: string): string {
  return seedProject(root, join(STORAGE, 'project-v3-demo-0003'), PROJECT_ID);
}

function envelopeOf(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'projects', PROJECT_ID, 'scenes', 'main.json'), 'utf8')) as Record<string, unknown>;
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

describe('packet 46 — the v3 envelope pipeline (workspace.md §16.4)', () => {
  it('loads every committed valid v3 envelope and rebuilds it byte-identically', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    const dir = join(CONTRACTS, 'envelope', 'valid');
    const files = readdirSync(dir);
    expect(files.length).toBe(3);
    for (const f of files) {
      const bytes = fileBytes(join(dir, f));
      const raw = JSON.parse(new TextDecoder().decode(bytes)) as { projectId: string };
      const res = validateEnvelope(bytes, raw.projectId);
      expect(res.ok, `${f}: ${JSON.stringify((res as { reason?: string }).reason)}`).toBe(true);
      if (!res.ok || res.storageVersion !== 3) continue;
      const rebuilt = buildEnvelopeBytesV3(raw.projectId, res.scene, res.content, res.records);
      expect(Buffer.compare(Buffer.from(rebuilt), Buffer.from(bytes)), f).toBe(0);
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
      const want = idx.fixtures[`envelope/invalid/${f}`]?.expect.result;
      expect(want, f).toBeDefined();
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
    const dir = join(root, 'projects', PROJECT_ID);
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          engineVersion: '0.1.0',
          id: PROJECT_ID,
          name: 'Beacon Reach',
          createdAt: CREATED_AT,
          scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
        },
        null,
        2,
      ) + '\n',
    );
    // A committed invalid v3 envelope (a dangling game cue) in a real project
    // layout: the session loader's §16.4 step-5 cross-block check must refuse.
    writeFileSync(
      join(dir, 'scenes', 'main.json'),
      fileBytes(join(CONTRACTS, 'envelope', 'invalid', 'cue-unresolved.json')),
    );
    const svc = open(root, SELF);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as {
      ok: boolean;
      error?: { reason?: string };
    };
    expect(q.ok).toBe(false);
    expect(q.error?.reason).toBe('asset_reference_missing');
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

describe('packet 46 — durable v3 write (workspace.md §5.3/§16.3)', () => {
  it('acks a v3 edit only after the durable six-key envelope write, and replays a lost-ack retry', () => {
    const root = makeRoot('m3store-write');
    seedV3(root);
    const svc = open(root, SELF);
    const q0 = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q0.ok).toBe(true);
    expect(q0.revision).toBe(3);

    const r = svc.runCommand(editTitle(1, 3, 'Beacon Reach II')) as MutationResult;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.revision).toBe(4);
    expect(r.duplicated).toBe(false);

    // The acked state is durable and canonical: the six-key v3 envelope.
    const envPath = join(root, 'projects', PROJECT_ID, 'scenes', 'main.json');
    const onDisk = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk['storageVersion']).toBe(3);
    expect(Object.keys(onDisk)).toEqual(['storageVersion', 'type', 'projectId', 'scene', 'content', 'retry']);
    expect(Object.keys(onDisk['content'] as object)).toEqual([
      'assets',
      'prefabs',
      'behaviors',
      'settings',
      'behaviorTrust',
      'game',
    ]);
    const retry = onDisk['retry'] as { records: { requestId: string; appliedRevision: number }[] };
    expect(retry.records.length).toBe(1);
    expect(retry.records[0]!.requestId).toBe('req-' + String(1).padStart(32, '0'));
    expect(retry.records[0]!.appliedRevision).toBe(4);
    const game = (onDisk['content'] as { game: { title: string } }).game;
    expect(game.title).toBe('Beacon Reach II');

    // A lost-ack retry with the same requestId replays durably (no rewrite).
    const before = readFileSync(envPath);
    const again = svc.runCommand(editTitle(1, 3, 'Beacon Reach II')) as MutationResult;
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.duplicated).toBe(true);
      expect(again.revision).toBe(4);
    }
    expect(Buffer.compare(before, readFileSync(envPath))).toBe(0);

    // A fresh open (same backend identity) loads the v3 state.
    svc.dispose();
    const svc2 = open(root, SELF);
    const q1 = svc2.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q1.ok).toBe(true);
    expect(q1.revision).toBe(4);
    svc2.dispose();
  });

  it('keeps the envelope the only mutable authoritative file (no side-car)', () => {
    const root = makeRoot('m3store-sidecar');
    seedV3(root);
    const svc = open(root, SELF);
    const r = svc.runCommand(editTitle(2, 3, 'One File')) as MutationResult;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const dir = join(root, 'projects', PROJECT_ID);
    for (const rel of ['game.json', 'settings.json', 'scene.json', 'content.json']) {
      expect(existsSync(join(dir, rel)), rel).toBe(false);
    }
    // The only mutable authoring file is scenes/main.json.
    const top = readdirSync(dir).sort();
    expect(top).toEqual(['.thirdlight', 'project.json', 'scenes']);
    svc.dispose();
  });

  it('classifies a controlled write fault as write_failed{previous} and leaves the v3 state unchanged', () => {
    const root = makeRoot('m3store-fault');
    seedV3(root);
    // Healthy open first (claim), then a faulted same-identity service.
    const healthy = open(root, SELF);
    expect((healthy.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean }).ok).toBe(true);
    healthy.dispose();
    const envPath = join(root, 'projects', PROJECT_ID, 'scenes', 'main.json');
    const before = readFileSync(envPath);
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
    expect(Buffer.compare(before, readFileSync(envPath))).toBe(0);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(3);
    svc.dispose();
  });

  it('pauses on an external v3 modification and accepts the operator resolution', () => {
    const root = makeRoot('m3store-ext');
    seedV3(root);
    const svc = open(root, SELF);
    // Load the project first (the external-change protocol is about a change
    // AFTER this backend loaded the state, workspace.md §5.2/§7.2).
    const q0 = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q0.ok).toBe(true);
    expect(q0.revision).toBe(3);
    const envPath = join(root, 'projects', PROJECT_ID, 'scenes', 'main.json');
    const foreign = JSON.parse(readFileSync(envPath, 'utf8')) as {
      scene: { revision: number };
      content: { game: { title: string } };
    };
    foreign.scene.revision = 4;
    foreign.content.game.title = 'Hand edited';
    writeFileSync(envPath, JSON.stringify(foreign, null, 2) + '\n');

    const r = svc.runCommand(editTitle(4, 3, 'Nope')) as MutationResult;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('external_change_unresolved');
    expect(svc.acceptExternalState(PROJECT_ID).ok).toBe(true);
    const q = svc.query({ op: 'queryProject', projectId: PROJECT_ID }) as { ok: boolean; revision: number };
    expect(q.ok).toBe(true);
    expect(q.revision).toBe(4);
    const onDisk = envelopeOf(root);
    expect((onDisk['content'] as { game: { title: string } }).game.title).toBe('Hand edited');
    svc.dispose();
  });
});

describe('packet 46 — v3 content reads (workspace.md §16.6)', () => {
  it('reports typed prepared-media facts for a v3 catalog and returns copy-safe verified bytes', async () => {
    const { validateEnvelope } = await import('../src/envelope');
    const { preparedMediaFacts } = await import('../src/content-store');
    const root = makeRoot('m3store-facts');
    seedV3(root);
    const svc = open(root, SELF);
    // Migrate the v2 source to obtain a v3 project with a real model asset.
    const v2 = join(root, 'projects', 'demo-0002');
    mkdirSync(join(v2, 'sources', 'sha256'), { recursive: true });
    mkdirSync(join(v2, 'scenes'), { recursive: true });
    writeFileSync(join(v2, 'project.json'), fileBytes(join(STORAGE, 'project-v2-demo-0002', 'project.json')));
    writeFileSync(join(v2, 'scenes', 'main.json'), fileBytes(join(STORAGE, 'project-v2-demo-0002', 'scenes', 'main.json')));
    const digest = 'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc';
    writeFileSync(
      join(v2, 'sources', 'sha256', digest),
      fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb')),
    );
    const mig = svc.migrateProjectCopyV3('demo-0002', 'demo-0004');
    expect(mig.ok, JSON.stringify(mig)).toBe(true);

    const integrity = svc.contentIntegrity('demo-0004');
    expect(integrity.ok, JSON.stringify(integrity)).toBe(true);
    const read = svc.readBlob('demo-0004', { assetId: 'asset-model-courier', version: 1 });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    if (read.ok) {
      expect(read.verified).toBe(true);
      expect(sha256Hex(read.bytes)).toBe(digest);
      expect(read.byteLength).toBe(47);
      // The returned bytes are an independent copy: mutating them cannot
      // change a later read (copy-safe immutable byte read).
      read.bytes[0] = 0;
    }
    const read2 = svc.readBlob('demo-0004', { assetId: 'asset-model-courier', version: 1 });
    expect(read2.ok).toBe(true);
    if (read2.ok) {
      expect(read2.bytes[0]).toBe(fileBytes(join(CONTRACTS, 'source-preimages', 'courier.glb'))[0]);
    }

    // The typed prepared-media facts (model kind).
    const envBytes = fileBytes(join(root, 'projects', 'demo-0004', 'scenes', 'main.json'));
    const env = validateEnvelope(envBytes, 'demo-0004');
    expect(env.ok, JSON.stringify(env)).toBe(true);
    if (env.ok && env.storageVersion === 3) {
      const ctx = {
        projectId: 'demo-0004',
        dir: join(root, 'projects', 'demo-0004'),
        thirdlightDir: join(root, 'projects', 'demo-0004', '.thirdlight'),
        storageVersion: 3 as const,
        revision: env.scene.revision,
        scene: env.scene,
        content: env.content,
      };
      const facts = preparedMediaFacts(ctx, 'asset-model-courier', 1);
      expect(facts.ok, JSON.stringify(facts)).toBe(true);
      if (facts.ok) {
        expect(facts.facts.kind).toBe('model');
        expect(facts.facts.sourceDigest).toBe(digest);
        expect(facts.facts.sourceByteLength).toBe(47);
        expect(facts.facts.importRecipe.profile).toBe('gltf-glb');
      }
      const missing = preparedMediaFacts(ctx, 'asset-model-courier', 9);
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('asset_version_not_found');
    }

    // The audio kind discriminator is typed from the committed media fixture.
    const mediaBytes = fileBytes(join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json'));
    const media = validateEnvelope(mediaBytes, 'demo-0003');
    expect(media.ok, JSON.stringify(media)).toBe(true);
    if (media.ok && media.storageVersion === 3) {
      const ctx = {
        projectId: 'demo-0003',
        dir: root,
        thirdlightDir: root,
        storageVersion: 3 as const,
        revision: media.scene.revision,
        scene: media.scene,
        content: media.content,
      };
      const audio = preparedMediaFacts(ctx, 'asset-audio-cue-start', 1);
      expect(audio.ok, JSON.stringify(audio)).toBe(true);
      if (audio.ok) expect(audio.facts.kind).toBe('audio');
    }

    const view = svc.captureContentView('demo-0004');
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (view.ok) {
      // The v2 source's asset record is unreferenced by any entity, so the v3
      // captured closure is empty (the view is a closure over scene/game
      // references, not the whole catalog).
      expect(view.view.assets.length).toBe(0);
    }
    svc.dispose();
  });

  it('captures a v3 view over modelAnimation and game cue references', () => {
    const root = makeRoot('m3store-view');
    const dir = join(root, 'projects', PROJECT_ID);
    mkdirSync(join(dir, 'scenes'), { recursive: true });
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          engineVersion: '0.1.0',
          id: PROJECT_ID,
          name: 'Beacon Reach',
          createdAt: CREATED_AT,
          scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
        },
        null,
        2,
      ) + '\n',
    );
    writeFileSync(
      join(dir, 'scenes', 'main.json'),
      fileBytes(join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json')),
    );
    const svc = open(root, SELF);
    const view = svc.captureContentView(PROJECT_ID);
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (view.ok) {
      // modelAnimation pins the model asset's recorded version; the game cues
      // reference the audio asset.
      const ids = view.view.assets.map((a) => a.assetId).sort();
      expect(ids).toEqual(['asset-audio-cue-start', 'asset-model-courier']);
      const model = view.view.assets.find((a) => a.assetId === 'asset-model-courier')!;
      expect(model.version).toBe(1);
      expect(model.sourceDigest).toBe(
        'ec535bb2ebcdecb508d7ea0372fe1562d547a9dd0fd5498d1d55c3e61ba44ecc',
      );
    }
    svc.dispose();
  });
});
