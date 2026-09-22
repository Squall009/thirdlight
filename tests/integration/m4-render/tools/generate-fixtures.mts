/**
 * Packet 69 — the committed fixture scene generator (deterministic).
 *
 * The fixture is the M4 template starter's FINAL scene (the accepted
 * 30-command recipe replayed through the REAL `@thirdlight/commands`
 * engine — the same deterministic requestIds the template contract
 * pins) with ONE documented DATA TRANSFORMATION applied to the scene
 * document: the player controller entity (`group-0001`) gains a `model`
 * and a `modelAnimation` component (courier asset, the same committed
 * clip names the template recipe binds for `model-0001` — the courier
 * GLB's real clip set, verified through the real pinned GLTFLoader by
 * the integration run):
 *
 *     model          = { asset: { assetId: "br-model-courier" } }
 *     modelAnimation = { assetId: "br-model-courier", version: 1,
 *                        roles: { idle: {clipIndex: 0, clipName: "Idle"},
 *                                 run: {clipIndex: 1, clipName: "Run"},
 *                                 airborne: {clipIndex: 2, clipName: "Airborne"} } }
 *
 * WHY A DATA TRANSFORMATION (not a command sequence): in the ACCEPTED
 * command set, `setComponent model` is a field EDIT only (never
 * add/remove — commands.md §8.10; `component_missing` otherwise), and
 * `createEntity` cannot create a second controller
 * (`controller_count_invalid`), while the game block must always name
 * the existing controller entity (project-v3 rule 1) — so the
 * (controller + model) combination, which the v3 scene validator
 * ACCEPTS (one structural component + the orthogonal controller), is
 * unreachable through commands. delivery.md (M4) §2.4 nevertheless
 * defines the behavior for "the player's own animated model", so the
 * fixture exercises it as committed fixture data (the same status as the
 * template's own hand-authored base scene). The transformation is
 * deterministic, documented here, and the result is validated by the
 * accepted `validateSceneV3` below; the runtime's instantiate path
 * re-validates the snapshot (the Node phase of the run).
 *
 * The result is a v3 scene where the PLAYER is an animated model entity
 * (the §2.4 player case) AND a non-player animated model entity exists
 * (`model-0001`, the constant-neutral-view case) — the "two instances
 * at distinct states" evidence fixture.
 *
 * Run: `npx tsx tests/integration/m4-render/tools/generate-fixtures.mts`
 *      `npx tsx ... --check` (byte-identity against the committed fixtures)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutation, createCommandState } from '@thirdlight/commands';
import { validateSceneV3, V3_REGISTRY } from '@thirdlight/project-model';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildBeaconGlb, buildCourierGlb } from './glb-build.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const TEMPLATE_DIR = join(ROOT, 'fixtures/m4/templates/templates/platformer-starter');
const OUT_DIR = join(HERE, '..', 'fixtures');
const SOURCES_DIR = join(OUT_DIR, 'sources');

// The template sample source whose defective animation bytes this fixture
// substitutes (the `sourceSubstitution` defect record below): the committed
// `courier.glb` (byte-identical in `samples/beacon-reach/assets/model/` and
// the template's `sources/model/`) carries miswired sampler input accessors
// — the sample generator's `tAcc = 3 + samplers.length * 2` collides with
// the part-index accessors, so the clip "key times" resolve to a box's 36
// vertex indices (non-monotonic). The accepted substrate validation
// rejects it with `asset_clip_invalid`. The repair is owned by the sample /
// template packets; the 69 fixture uses packet-owned GLB bytes of the same
// structure (same clip names/order/channels, 4 s).
const DEFECT_SOURCE = join(TEMPLATE_DIR, 'sources/model/courier.glb');

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

const recipe = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'recipe/commands.json'), 'utf8')) as { templateId: string; commands: Array<{ op: string; args: unknown }> };
const baseDoc = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'base/scene.json'), 'utf8')) as unknown as { scene?: unknown; [k: string]: unknown };

// The template base document is a scene document (schemaVersion 3, revision
// 0) — the same shape the template operator writes as the envelope's scene.
const baseScene = baseDoc as { schemaVersion: number; sceneId: string; revision: number; entities: unknown[] };

const content = { assets: [] as unknown[], prefabs: [] as unknown[], behaviors: [] as unknown[], settings: {} as Record<string, number>, behaviorTrust: { entries: [] }, game: null as unknown };
let state = createCommandState(baseScene as never, content as never);

// Phase 1: the accepted 30-command recipe (the template's deterministic
// requestIds — templates.md §7.2).
const origin = { kind: 'admin' as const, clientId: 'fixture-generator' };
const requestIds: string[] = [];
for (let i = 0; i < recipe.commands.length; i += 1) {
  const cmd = recipe.commands[i];
  const requestId = `req-${createHash('sha256').update(Buffer.from(`${recipe.templateId}@1#${i + 1}`, 'utf8')).digest('hex').slice(0, 32)}`;
  requestIds.push(requestId);
  const request = { op: cmd.op, projectId: 'm469-0001', expectedRevision: state.scene.revision, requestId, origin, args: cmd.args } as never;
  const outcome = applyMutation(state, request);
  if (!outcome.ok) {
    console.error(`recipe command ${i + 1} (${cmd.op}) FAILED:`, JSON.stringify((outcome as { result: unknown }).result));
    process.exit(1);
  }
  state = (outcome as { state: typeof state }).state;
}

// Phase 2: the documented data transformation (see the header). The player
// controller entity gains a model + modelAnimation in canonical component
// order (V3_REGISTRY). This combination is accepted by the v3 scene
// validator (one structural component + the orthogonal controller) but is
// unreachable through the accepted command set (commands.md §8.10: `model`
// is edit-only; a second controller is rejected; the game block must name
// the existing controller entity) — the fixture exercises the delivery.md
// (M4) §2.4 player-model case as committed fixture data.
const PLAYER_ID = 'group-0001';
const PLAYER_MODEL = { asset: { assetId: 'br-model-courier' } };
const PLAYER_MODEL_ANIMATION = {
  assetId: 'br-model-courier',
  version: 1,
  roles: {
    idle: { clipIndex: 0, clipName: 'Idle' },
    run: { clipIndex: 1, clipName: 'Run' },
    airborne: { clipIndex: 2, clipName: 'Airborne' },
  },
};
const registryOrder: Record<string, number> = {};
V3_REGISTRY.forEach((k, i) => { registryOrder[k] = i; });
{
  const entities = (state.scene as { entities: Array<{ id: string; components: Record<string, unknown> }> }).entities;
  const playerIdx = entities.findIndex((e) => e.id === PLAYER_ID);
  if (playerIdx < 0 || entities[playerIdx].components['controller'] === undefined) {
    console.error('the recipe replay did not leave a controller entity at', PLAYER_ID);
    process.exit(1);
  }
  const comps = { ...entities[playerIdx].components };
  comps['model'] = PLAYER_MODEL;
  comps['modelAnimation'] = PLAYER_MODEL_ANIMATION;
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(comps).sort((a, b) => (registryOrder[a] ?? 99) - (registryOrder[b] ?? 99))) {
    ordered[k] = comps[k];
  }
  const next = [...entities];
  next[playerIdx] = { ...entities[playerIdx], components: ordered };
  const transformed = { ...(state.scene as object), revision: (state.scene as { revision: number }).revision + 1, entities: next } as typeof state.scene;
  const sceneCheck = validateSceneV3(transformed as never);
  if (!sceneCheck.ok) {
    console.error('the transformed scene fails the accepted validateSceneV3:', JSON.stringify((sceneCheck as { errors: unknown }).errors));
    process.exit(1);
  }
  state = { ...state, scene: transformed } as typeof state;
}

const scene = state.scene as { schemaVersion: number; sceneId: string; revision: number; entities: Array<{ id: string; components: Record<string, unknown> }> };
const cont = state.content as { assets: Array<Record<string, unknown>>; settings: Record<string, number>; game: unknown };

// ---- structural assertions (the fixture invariants) ------------------------
function assert(cond: unknown, message: string): void {
  if (!cond) {
    console.error('fixture assertion failed:', message);
    process.exit(1);
  }
}
assert(scene.schemaVersion === 3, 'the fixture scene is v3');
assert(scene.revision === 31, `final revision 31 (30 recipe + 1 transformation), got ${scene.revision}`);
const byId = new Map(scene.entities.map((e) => [e.id, e]));
const player = byId.get('group-0001');
assert(player !== undefined, 'the player entity exists');
assert(player?.components['model'] !== undefined, 'the player carries a model component');
assert(player?.components['modelAnimation'] !== undefined, 'the player carries a modelAnimation component');
assert(player?.components['controller'] !== undefined, 'the player is still the controller entity');
const animated = scene.entities.filter((e) => e.components['modelAnimation'] !== undefined);
assert(animated.length === 2, `exactly two modelAnimation entities (player + model-0001), got ${animated.length}`);
const modelEntities = scene.entities.filter((e) => e.components['model'] !== undefined);
const modelAssets = cont.assets.filter((a) => a['kind'] === 'model') as Array<{ assetId: string; versions?: Array<{ version: number; sourceDigest: string; sourceByteLength: number }> }>;
assert(modelAssets.length === 2, `two model asset records, got ${modelAssets.length}`);
for (const a of modelAssets) {
  assert(a.versions !== undefined && a.versions.length >= 1, `asset ${a.assetId} has version rows`);
}
// Every model entity resolves to a model asset record (the closure).
for (const e of modelEntities) {
  const m = e.components['model'] as { asset: { assetId: string } };
  assert(modelAssets.some((a) => a.assetId === m.asset.assetId), `model entity ${e.id} resolves to an asset record`);
}

// ---- the packet-owned GLB sources (the documented substitution) -----------
// The scene content's model asset rows carry the TEMPLATE blob digests;
// the 69 fixture substitutes packet-owned GLB bytes for those assetIds
// (same structure, valid key times). The mapping is exact: one GLB per
// model assetId present in the scene content.
const glbByAssetId = new Map<string, { name: string; bytes: Uint8Array }>([
  ['br-model-courier', { name: 'courier', bytes: buildCourierGlb() }],
  ['br-model-beacon', { name: 'beacon', bytes: buildBeaconGlb() }],
]);
for (const a of modelAssets) {
  if (!glbByAssetId.has(a.assetId as string)) {
    console.error('no packet-owned GLB for the model assetId', a.assetId);
    process.exit(1);
  }
}
// Self-check through the REAL pinned GLTFLoader: the clip names/order and
// the key-time monotonicity must hold before the bytes are committed.
function parseGlb(bytes: Uint8Array): Promise<unknown> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Promise<unknown>((resolve, reject) => {
    new GLTFLoader().parse(buf, '', (gltf) => resolve(gltf), (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}
async function selfCheckGlb(assetId: string, bytes: Uint8Array, expectedClips: string[] | null): Promise<void> {
  const gltf = (await parseGlb(bytes)) as { animations: Array<{ name: string; tracks: Array<{ name: string; times: Float32Array }> }> };
  const names = gltf.animations.map((c) => c.name);
  if (expectedClips !== null && JSON.stringify(names) !== JSON.stringify(expectedClips)) {
    console.error(`${assetId}: clip names/order ${JSON.stringify(names)} !== ${JSON.stringify(expectedClips)}`);
    process.exit(1);
  }
  for (const clip of gltf.animations) {
    for (const track of clip.tracks) {
      const times = track.times;
      for (let i = 1; i < times.length; i += 1) {
        if (!Number.isFinite(times[i]) || !(times[i] > times[i - 1])) {
          console.error(`${assetId}: ${clip.name}/${track.name} has non-finite or non-monotonic key times`);
          process.exit(1);
        }
      }
    }
  }
}
await selfCheckGlb('br-model-courier', glbByAssetId.get('br-model-courier')?.bytes ?? new Uint8Array(0), ['Idle', 'Run', 'Airborne']);
await selfCheckGlb('br-model-beacon', glbByAssetId.get('br-model-beacon')?.bytes ?? new Uint8Array(0), null);

// ---- the committed fixture documents ---------------------------------------
const assetRows = modelAssets
  .map((a) => {
    const glb = glbByAssetId.get(a.assetId as string) as { name: string; bytes: Uint8Array };
    return { assetId: a.assetId, version: 1, sourceDigest: sha256Hex(glb.bytes), sourceByteLength: glb.bytes.byteLength };
  })
  .sort((x, y) => (x.assetId < y.assetId ? -1 : 1));
const animationRows = animated
  .map((e) => {
    const ma = e.components['modelAnimation'] as { assetId: string; version: number; roles: unknown };
    return { entityId: e.id, assetId: ma.assetId, version: ma.version, roles: ma.roles };
  })
  .sort((x, y) => (x.entityId < y.entityId ? -1 : 1));

const index = {
  schemaVersion: 1,
  type: 'thirdlight-m469-fixture-index',
  generatedBy: 'tests/integration/m4-render/tools/generate-fixtures.mts',
  provenance: {
    template: { templateId: recipe.templateId, version: 1 },
    projectId: 'm469-0001',
    finalRevision: scene.revision,
    recipeCommandCount: recipe.commands.length,
    dataTransformation: 'group-0001 gains model + modelAnimation (courier asset; delivery.md (M4) §2.4 player-model case; unreachable via commands — see generator header)',
    requestIds,
  },
  sceneDigest: sha256Hex(new TextEncoder().encode(`${JSON.stringify(scene, null, 2)}\n`)),
  settings: cont.settings,
  game: cont.game,
  assetRows,
  animationRows,
  modelEntityIds: modelEntities.map((e) => e.id),
  playerEntityId: 'group-0001',
  sourceSubstitution: {
    reason: 'the template/sample source courier.glb carries corrupted animation data and fails the accepted substrate validation (asset_clip_invalid); the 69 fixture uses packet-owned GLB bytes of the same clip structure for the same assetIds (the scene document and the committed clip bindings are unchanged)',
    defectiveFile: {
      path: 'fixtures/m4/templates/templates/platformer-starter/sources/model/courier.glb',
      byteIdenticalWith: 'samples/beacon-reach/assets/model/courier.glb',
      digest: sha256Hex(new Uint8Array(readFileSync(DEFECT_SOURCE))),
    },
    rootCause: 'samples/beacon-reach/tools/generate-assets.mjs: the animation sampler accessor index (tAcc = 3 + samplers.length * 2) collides with the part-index accessors, so the sampler input reads a box vertex-index accessor as the key times (non-monotonic; 79 non-monotonic transitions of 179 per track). Latent in M3 (the sample courier is static — no modelAnimation binding); surfaced by the M4 template clip binding.',
    observed: 'the real pinned GLTFLoader parses the file, but every clip track times are the box vertex indices (values 0..7); the substrate rejects clip 0 with asset_clip_invalid (clip 0 carries non-finite or non-monotonic key times)',
    repair: 'owned by the sample/template packets (out of the 69 may-edit boundary) — refiled in the 69 handoff',
    replacement: {
      generatedBy: 'tests/integration/m4-render/tools/glb-build.mts (deterministic; real GLTFLoader self-checked at generation)',
      structure: 'same clip names/order (Idle, Run, Airborne) and channel layout (Idle: Arm.quaternion; Run/Airborne: Arm.quaternion + Arm.position), 4.0 s duration, 9 monotonic keyframes',
      paths: assetRows.map((r) => `tests/integration/m4-render/fixtures/sources/${r.assetId.replace(/^br-model-/, '')}.glb`),
    },
  },
};

const check = process.argv.includes('--check');
function emit(path: string, doc: unknown, rawBytes?: Uint8Array): void {
  const bytes = rawBytes ?? new TextEncoder().encode(`${JSON.stringify(doc, null, 2)}\n`);
  if (check) {
    const existing = readFileSync(path);
    if (existing.byteLength !== bytes.byteLength || !existing.every((b, i) => b === bytes[i])) {
      console.error(`--check: ${path} differs from the regenerated bytes`);
      process.exit(1);
    }
    console.log(`check ok: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`wrote: ${path} (${bytes.byteLength} bytes)`);
}
emit(join(OUT_DIR, 'scene.json'), scene);
for (const a of modelAssets) {
  const glb = glbByAssetId.get(a.assetId as string) as { name: string; bytes: Uint8Array };
  emit(join(SOURCES_DIR, `${glb.name}.glb`), null, glb.bytes);
}
emit(join(OUT_DIR, 'index.json'), index);
if (check) console.log('fixture check: byte-identical');