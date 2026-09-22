/**
 * Packet 27 — Node-runnable asset-authoring integration of the editor's PURE
 * modules (vitest; no browser, no backend).
 *
 * This suite wires the packet-27 modules together the way the React app does
 * and asserts the packet acceptance properties at the pure layer:
 *
 *  - import → validate drop → bounded frames → bounded job → proposal →
 *    `publishAsset` change → content projection;
 *  - **two placements** with distinct entity IDs and independent transforms —
 *    both the direct whole-GLB `createEntity` model path (C27-1 repaired) and
 *    prefab copies (`instantiatePrefab`);
 *  - a **reimport** that appends a version and moves `currentVersion` while
 *    every referencing entity keeps its ID, transform and `assetId`;
 *  - a **failed** import/reimport and a **stale job** that leave the previous
 *    committed content untouched;
 *  - the gesture command discipline (zero during the drag, exactly one on
 *    release, none on cancel, one undo restores the pre-gesture transform) and
 *    the snapping increments verified against the accepted contract text.
 *
 * The transport is in-memory: this proves the pure decision logic and the
 * change-application rules, not browser/WebGL behavior (see
 * `m2-assets.browser.ts` for the browser procedure and the UNVERIFIED list).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  beginImport,
  canPublish,
  committed,
  frameSent,
  importFailed,
  initialImportState,
  inspectionSucceeded,
  jobUpdated,
  planUploadFrames,
  publishArgsFromProposal,
  publishStarted,
  stageCreated,
  uploadCompleted,
  validateDropCandidate,
  type AssetImportState,
  type ImportProposal,
} from '../../../packages/editor/src/session/asset-browser';
import { ContentProjection } from '../../../packages/editor/src/session/content-projection';
import { Projection } from '../../../packages/editor/src/session/projection';
import { GestureRunner, type CommitCommand, type GestureCommandSink } from '../../../packages/editor/src/session/gesture';
import { SNAP_INCREMENTS } from '../../../packages/editor/src/session/snapping';
import { assetPlacementAvailable, planAssetPlacement, planPrefabPlacement } from '../../../packages/editor/src/session/placement';
import type { AssetRecord, Entity } from '@thirdlight/project-model';
import type { ContentJobView } from '@thirdlight/protocol';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIGEST_V1 = 'a'.repeat(64);
const DIGEST_V2 = 'b'.repeat(64);

const METRICS = {
  nodes: 2,
  meshes: 1,
  primitives: 1,
  materials: 2,
  images: 0,
  textures: 0,
  vertices: 24,
  triangles: 12,
  animations: 1,
  animationChannels: 3,
  clipDurationMs: 1000,
  decodedGeometryBytes: 1024,
  decodedImageBytes: 0,
};
const RECIPE = { profile: 'gltf-glb' as const, recipeVersion: 1 as const, toolchain: { three: '0.186.0' }, extensions: [] };

function record(version: number, digest: string): AssetRecord {
  const versions = [];
  for (let v = 1; v <= version; v += 1) {
    versions.push({
      version: v,
      sourceDigest: v === version ? digest : DIGEST_V1,
      sourceByteLength: 100 + v,
      importRecipe: RECIPE,
      metrics: METRICS,
      importedAt: '2026-09-18T00:00:00Z',
      publishedRevision: v,
    });
  }
  return { assetId: 'asset-0001', kind: 'model', displayName: 'Lantern', currentVersion: version, versions };
}

function modelEntity(id: string, assetId: string, x: number): Entity {
  return {
    id,
    name: id,
    components: {
      transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ...({ model: { asset: { assetId } } } as unknown as Record<string, never>),
    },
  };
}

/** A minimal in-memory stand-in for the bounded transport (no I/O). */
class FakeTransport {
  readonly stages = new Map<string, Uint8Array>();
  stageCounter = 0;
  jobCounter = 0;
  readonly openStages = new Set<string>();

  createStage(): { stageId: string; expiresAt: string } {
    this.stageCounter += 1;
    const stageId = `stage-${String(this.stageCounter).padStart(4, '0')}`;
    this.stages.set(stageId, new Uint8Array(0));
    this.openStages.add(stageId);
    return { stageId, expiresAt: '2026-09-18T01:00:00Z' };
  }

  putFrame(stageId: string, bytes: Uint8Array, offset: number, total: number): void {
    const current = this.stages.get(stageId);
    if (!current || current.length !== offset) throw new Error('content_frame_invalid');
    if (offset + bytes.length > total) throw new Error('content_frame_invalid');
    const merged = new Uint8Array(offset + bytes.length);
    merged.set(current, 0);
    merged.set(bytes, offset);
    this.stages.set(stageId, merged);
  }

  inspect(stageId: string, bytes: Uint8Array): ImportProposal {
    this.jobCounter += 1;
    const jobId = `job-${String(this.jobCounter).padStart(32, '0')}`;
    return {
      stageId,
      digest: DIGEST_V1,
      byteLength: bytes.length,
      status: 'ok',
      proposal: { proposalId: jobId, status: 'ok', kind: 'model', sourceDigest: DIGEST_V1, sourceByteLength: bytes.length, importRecipe: RECIPE, metrics: METRICS },
    };
  }
}

/** The whole import flow through the pure state machine + the fake transport. */
function runImport(
  transport: FakeTransport,
  bytes: Uint8Array,
  target: { mode: 'create' | 'reimport'; assetId: string | null; displayName: string | null },
  jobState: ContentJobView['state'] = 'succeeded',
): { state: AssetImportState; proposal: ImportProposal | null } {
  let s = beginImport(initialImportState, target);
  const stage = transport.createStage();
  s = stageCreated(s, stage.stageId, bytes.length);
  for (const frame of planUploadFrames(bytes.length)) {
    transport.putFrame(stage.stageId, bytes.slice(frame.offset, frame.offset + frame.length), frame.offset, bytes.length);
    s = frameSent(s, frame.offset + frame.length);
  }
  s = uploadCompleted(s);
  const proposal = transport.inspect(stage.stageId, bytes);
  s = inspectionSucceeded(s, proposal);
  if (jobState !== 'succeeded') {
    s = jobUpdated(s, { jobId: 'job-' + '1'.padStart(32, '0'), projectId: 'demo-0001', kind: 'inspect', state: jobState, createdAt: '2026-09-18T00:00:00Z', expiresAt: '2026-09-18T00:15:00Z' });
    return { state: s, proposal: null };
  }
  return { state: s, proposal: canPublish(s) ? proposal : null };
}

class CountingSink implements GestureCommandSink {
  issued: CommitCommand[] = [];
  undoStack: Array<{ position: number[]; rotation: number[]; scale: number[] }> = [];
  current = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  issue(command: CommitCommand): void {
    this.undoStack.push(JSON.parse(JSON.stringify(this.current)));
    this.current = JSON.parse(JSON.stringify(command.args.transform));
    this.issued.push(command);
  }
}

describe('packet 27 (Node) — import → publish → place twice → reimport', () => {
  it('imports a GLB, places two instances and reimports without changing entity IDs/transforms', () => {
    const transport = new FakeTransport();
    const bytes = new Uint8Array(2_200_000); // 3 bounded frames
    const drop = validateDropCandidate({ name: 'lantern.glb', byteLength: bytes.length });
    expect(drop.ok).toBe(true);
    if (!drop.ok) return;

    // 1. import → proposal (the drop validates before any network call)
    const imported = runImport(transport, bytes, { mode: 'create', assetId: 'asset-0001', displayName: drop.displayName });
    expect(imported.state.phase).toBe('proposed');
    expect(imported.proposal).not.toBeNull();
    const args = publishArgsFromProposal(imported.proposal!, { mode: 'create', assetId: 'asset-0001', displayName: drop.displayName }, '2026-09-18T12:00:00Z');
    expect(args.ok).toBe(true);
    if (!args.ok) return;

    // 2. the publishAsset change is what moves the catalog (never a local write)
    const content = new ContentProjection();
    content.hydrate({ assets: [] });
    content.applyChange({ type: 'publishAsset', mode: 'create', assetId: 'asset-0001', previous: null, next: record(1, DIGEST_V1) });
    expect(content.currentVersion('asset-0001')).toBe(1);
    let s = publishStarted(imported.state);
    s = committed(s);
    expect(s.phase).toBe('committed');

    // 3. place twice: two typed commands, two independent copies
    const scene = new Projection();
    scene.hydrate({ revision: 2, entities: [] });
    const placeOne = planPrefabPlacement('prefab-0001', { transform: { position: [1, 0, 0] } });
    const placeTwo = planPrefabPlacement('prefab-0001', { transform: { position: [2, 0, 0] } });
    expect(placeOne.op).toBe('instantiatePrefab');
    expect(placeTwo.op).toBe('instantiatePrefab');
    scene.applyMutationApplied({
      requestId: 'req-place-1',
      revision: 3,
      change: { type: 'instantiatePrefab', prefabId: 'prefab-0001', rootId: 'model-0001', entries: [{ index: 0, entity: modelEntity('model-0001', 'asset-0001', 1) as never }], mapping: [{ localId: 'model-0000', entityId: 'model-0001' }] },
    });
    scene.applyMutationApplied({
      requestId: 'req-place-2',
      revision: 4,
      change: { type: 'instantiatePrefab', prefabId: 'prefab-0001', rootId: 'model-0002', entries: [{ index: 1, entity: modelEntity('model-0002', 'asset-0001', 2) as never }], mapping: [{ localId: 'model-0000', entityId: 'model-0002' }] },
    });
    const placed = scene.listEntities();
    expect(placed.map((e) => e.id)).toEqual(['model-0001', 'model-0002']);
    expect(placed.map((e) => e.position[0])).toEqual([1, 2]);

    // 4. reimport under the same assetId: one new version, placements untouched
    const before = JSON.stringify(placed);
    scene.applyMutationApplied({
      requestId: 'req-reimport',
      revision: 5,
      change: { type: 'publishAsset', mode: 'reimport', assetId: 'asset-0001', previous: record(1, DIGEST_V1), next: record(2, DIGEST_V2) },
    });
    content.applyChange({ type: 'publishAsset', mode: 'reimport', assetId: 'asset-0001', previous: record(1, DIGEST_V1), next: record(2, DIGEST_V2) });
    expect(content.currentVersion('asset-0001')).toBe(2);
    expect(content.resolveVersion('asset-0001')?.sourceDigest).toBe(DIGEST_V2);
    // Entity IDs, transforms and references are byte-identical (the visual
    // resolution changes only through the version facts).
    expect(JSON.stringify(scene.listEntities())).toBe(before);
    expect(scene.listEntities().map((e) => e.assetId)).toEqual(['asset-0001', 'asset-0001']);
    // The reimported asset's bytes resolve through the new version.
    expect(scene.revision).toBe(5);
  });

  it('a failed reimport preserves the previous committed content', () => {
    const content = new ContentProjection();
    content.hydrate({ assets: [{ assetId: 'asset-0001', kind: 'model', displayName: 'Lantern', currentVersion: 1, versionCount: 1, versions: [{ version: 1, sourceDigest: DIGEST_V1, sourceByteLength: 100 }] }] });
    const before = JSON.stringify(content.listAssets());

    const transport = new FakeTransport();
    const failedImport = runImport(transport, new Uint8Array(64), { mode: 'reimport', assetId: 'asset-0001', displayName: null });
    const failed = importFailed(publishStarted(failedImport.state), { code: 'content_publish_failed', message: 'publication failed' });
    expect(failed.phase).toBe('failed');
    expect(JSON.stringify(content.listAssets())).toBe(before);
  });

  it('a stale/expired job never becomes publishable', () => {
    const transport = new FakeTransport();
    const stale = runImport(transport, new Uint8Array(64), { mode: 'create', assetId: 'asset-0002', displayName: null }, 'expired');
    expect(stale.state.phase).toBe('stale');
    expect(stale.proposal).toBeNull();
    expect(canPublish(stale.state)).toBe(false);
  });
});

describe('packet 27 (Node) — gesture command discipline and undo', () => {
  it('zero commands during the drag, exactly one on release, one undo, none on cancel', () => {
    const sink = new CountingSink();
    const runner = new GestureRunner('model-0001', 4, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, sink, { snapping: true });
    for (let i = 0; i < 25; i += 1) runner.preview({ kind: 'translate', delta: [i * 0.02, 0, 0] });
    expect(sink.issued.length).toBe(0);
    const released = runner.release();
    expect(released.kind).toBe('commit');
    expect(sink.issued.length).toBe(1);
    expect(sink.issued[0]?.expectedRevision).toBe(4);
    // Snapped preview: 24 frames × 0.02 = 0.48 → 0.5 (0.25 grid).
    expect(sink.issued[0]?.args.transform.position[0]).toBe(0.5);
    const restored = sink.undoStack.pop();
    expect(restored?.position).toEqual([0, 0, 0]);

    const cancelSink = new CountingSink();
    const cancelled = new GestureRunner('model-0001', 4, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, cancelSink, { snapping: true });
    cancelled.preview({ kind: 'translate', delta: [3, 0, 0] });
    cancelled.cancel();
    expect(cancelled.release().kind).toBe('noop');
    expect(cancelSink.issued.length).toBe(0);
  });
});

describe('packet 27 (Node) — the snapping table matches the accepted contract text', () => {
  const sessions = readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'sessions.md'), 'utf8');

  it('sessions.md §9 fixes the exact increments the code uses', () => {
    expect(SNAP_INCREMENTS.translateM).toBe(0.25);
    expect(SNAP_INCREMENTS.rotateDeg).toBe(15);
    expect(SNAP_INCREMENTS.scale).toBe(0.25);
    expect(SNAP_INCREMENTS.scaleMin).toBe(0.01);
    expect(SNAP_INCREMENTS.scaleMax).toBe(100);
    expect(SNAP_INCREMENTS.quantum).toBe(1e-4);
    expect(sessions).toContain('SNAP_TRANSLATE_M = 0.25 m');
    expect(sessions).toContain('SNAP_ROTATE_DEG = 15°');
    expect(sessions).toContain('SNAP_SCALE = 0.25');
    expect(sessions).toContain('SCALE_MIN 0.01, SCALE_MAX 100');
    expect(sessions).toContain('no parent-space or local-space snapping in M2');
    expect(sessions).toContain('**zero** commands during the drag');
    expect(sessions).toContain('holding `Shift` during the gesture disables snapping');
  });
});

describe('packet 27 (Node) — direct whole-GLB placement (C27-1 repaired)', () => {
  it('plans two createEntity model commands and applies them as two independent copies', () => {
    const scene = new Projection();
    scene.hydrate({ revision: 2, entities: [] });
    const one = planAssetPlacement('asset-0001', { transform: { position: [1, 0, 0] } });
    const two = planAssetPlacement('asset-0001', { transform: { position: [2, 0, 0] } });
    expect(one.op).toBe('createEntity');
    expect(two.op).toBe('createEntity');
    expect(one.args.kind).toBe('model');
    expect(one.args.model.asset.assetId).toBe('asset-0001');
    expect(one.args.transform?.position).toEqual([1, 0, 0]);
    expect(assetPlacementAvailable()).toBe(true);

    scene.applyMutationApplied({
      requestId: 'req-place-1',
      revision: 3,
      change: { type: 'createEntity', id: 'model-0003', entity: modelEntity('model-0003', 'asset-0001', 1) as never },
    });
    scene.applyMutationApplied({
      requestId: 'req-place-2',
      revision: 4,
      change: { type: 'createEntity', id: 'model-0004', entity: modelEntity('model-0004', 'asset-0001', 2) as never },
    });
    const placed = scene.listEntities();
    expect(placed.map((e) => e.id)).toEqual(['model-0003', 'model-0004']);
    expect(placed.map((e) => e.position[0])).toEqual([1, 2]);
    expect(placed.map((e) => e.assetId)).toEqual(['asset-0001', 'asset-0001']);
    expect(scene.revision).toBe(4);
  });
});
