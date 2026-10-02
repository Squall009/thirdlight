/**
 * Build a generated benchmark plan into a project through the
 * real HTTP API — the command endpoint (the one mutation path) and the
 * content routes (stages, the model import, behavior publishing, instance
 * buffers) — exactly as the editor or MCP would.
 */
import { createHash } from 'node:crypto';

import { multiPieceGlb } from '../../tests/e2e/multi-piece-glb';
import { noisePng, sphereGlb } from './assets';
import type { BenchPlan, EntityValue } from './generate';
import type { PerfBackend } from './backend';

export interface BuildResult {
  projectId: string;
  ms: number;
  commands: number;
  revision: number;
  entities: number;
}

const importedAt = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A command request is at most 64 KiB (canonical): pastes stay well below it. */
const PASTE_BYTES = 48_000;

/** Split a paste at group boundaries (a root and the entities naming it as parent) into parts under PASTE_BYTES. */
export function splitBySize(batch: readonly EntityValue[]): EntityValue[][] {
  const units: EntityValue[][] = [];
  for (const e of batch) {
    const last = units[units.length - 1];
    if (e.parentId !== undefined && last !== undefined && last[0]!.id === e.parentId) last.push(e);
    else units.push([e]);
  }
  const parts: EntityValue[][] = [];
  let part: EntityValue[] = [];
  let bytes = 0;
  for (const unit of units) {
    const size = JSON.stringify(unit).length;
    if (part.length > 0 && bytes + size > PASTE_BYTES) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(...unit);
    bytes += size;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

export async function buildBenchmark(be: PerfBackend, plan: BenchPlan, projectId: string, log: (s: string) => void = () => undefined): Promise<BuildResult> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: `Benchmark ${plan.className}` });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  let commands = 0;
  const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    commands += 1;
    return p.command(op, args);
  };

  // A file: staged, inspected and published like an imported file.
  const publishFile = async (assetId: string, kind: 'model' | 'texture', displayName: string, bytes: Uint8Array): Promise<void> => {
    const stageId = await be.stage(projectId, bytes);
    const inspected = await be.post(`/api/v1/projects/${projectId}/content/stages/${stageId}/inspect`, { kind });
    const proposal = inspected.json['proposal'] as Record<string, unknown> | undefined;
    if (proposal === undefined) throw new Error(`${kind} inspect failed: ${JSON.stringify(inspected.json).slice(0, 400)}`);
    await cmd('publishAsset', {
      mode: 'create',
      assetId,
      kind,
      displayName,
      sourceDigest: proposal['sourceDigest'],
      sourceByteLength: proposal['sourceByteLength'],
      importRecipe: proposal['importRecipe'],
      metrics: proposal['metrics'],
      importedAt: importedAt(),
    });
    await be.discardStage(projectId, stageId);
  };
  // The class's own texture and model files (before the materials that use them).
  for (const f of plan.files.textures) await publishFile(f.assetId, 'texture', f.displayName, noisePng(f.seed, f.size));
  for (const f of plan.files.models) await publishFile(f.assetId, 'model', f.displayName, sphereGlb(f.seed, f.segments, f.size));
  if (plan.files.models.length + plan.files.textures.length > 0) log(`${plan.className}: ${plan.files.models.length} model files, ${plan.files.textures.length} textures`);

  for (const material of plan.materials) await cmd('setMaterial', { material });
  log(`${plan.className}: ${plan.materials.length} materials`);

  // The model kit.
  await publishFile(plan.model.assetId, 'model', plan.model.displayName, multiPieceGlb(plan.model.pieces));

  // Scripts: declaration, trust for the source digest, then the published source.
  for (const b of plan.behaviors) {
    const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: b.ownedTransforms, files: [{ path: 'src/index.ts', text: b.source }] }, null, 2)}\n`);
    const stageId = await be.stage(projectId, bytes);
    await cmd('publishBehavior', { behaviorId: b.behaviorId, displayName: b.displayName, mode: 'declaration-create', declaration: b.declaration });
    await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
    commands += 1;
    const published = await be.post(`/api/v1/projects/${projectId}/content/behaviors/source`, {
      stageId,
      behaviorId: b.behaviorId,
      displayName: b.displayName,
      declaration: b.declaration,
      expectedRevision: await p.revision(),
      requestId: `req-${createHash('sha256').update(`${projectId}:${b.behaviorId}`).digest('hex').slice(0, 32)}`,
    });
    if (published.status !== 200) throw new Error(`publish ${b.behaviorId} failed: ${JSON.stringify(published.json).slice(0, 400)}`);
    await p.revision();
  }
  log(`${plan.className}: ${plan.behaviors.length} scripts`);

  for (const effect of plan.effects) await cmd('setEffect', { effect });

  const digests = new Map<string, string>();
  for (const buf of plan.buffers) {
    const bytes = new Uint8Array(buf.floats.buffer, buf.floats.byteOffset, buf.floats.byteLength);
    const stageId = await be.stage(projectId, bytes);
    const res = await be.post(`/api/v1/projects/${projectId}/content/buffers`, { stageId });
    if (res.status !== 200 || typeof res.json['digest'] !== 'string') throw new Error(`buffer publish failed: ${JSON.stringify(res.json).slice(0, 400)}`);
    digests.set(buf.key, res.json['digest']);
  }

  for (const scene of plan.scenes.slice(1)) await cmd('createScene', { sceneId: scene.sceneId, name: scene.name });
  if (plan.scenes.length > 1) await cmd('setStartScenes', { sceneIds: plan.startScenes });

  // Camera, player, spawn and a camera track following the player (the game plays as a scene; a camera track
  // rig is what follows the player).
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: plan.camera.position } });
  // The lens of every camera that sets none (the starter's camera and the track below).
  await cmd('setSettings', { settings: { camera_fov_deg: 50, camera_far_m: plan.camera.far } });
  await cmd('createEntity', { kind: 'group', name: 'Start spawn', transform: { position: plan.spawn }, components: { playerSpawn: {} } });
  const player = await cmd('createEntity', { kind: 'box', name: 'Player', transform: { position: plan.player.position }, box: { size: plan.player.size, material: { color: '#3070c0' } }, components: { controller: {} } });
  await cmd('createEntity', { kind: 'group', name: 'Camera track', transform: { position: plan.camera.position }, components: { virtualCamera: { rig: 'track', target: player['createdId'], deadZone: [1, 1, 1], damping: 0.2 } } });

  const resolve = (e: EntityValue): EntityValue => {
    const inst = e.components['instances'] as { buffer?: string } | undefined;
    if (inst?.buffer?.startsWith('$buffer:') !== true) return e;
    const digest = digests.get(inst.buffer.slice('$buffer:'.length));
    if (digest === undefined) throw new Error(`no buffer ${inst.buffer}`);
    return { ...e, components: { ...e.components, instances: { ...inst, buffer: digest } } };
  };
  let entities = 6;
  for (const scene of plan.scenes) {
    for (const batch of scene.batches) {
      for (const part of splitBySize(batch.map(resolve))) {
        await cmd('pasteEntities', { sceneId: scene.sceneId, entities: part });
        entities += part.length;
      }
    }
    log(`${plan.className}: scene ${scene.sceneId} (${entities} entities so far)`);
  }
  return { projectId, ms: Math.round(performance.now() - t0), commands, revision: await p.revision(), entities };
}
