/**
 * Phase 24.7: takes the platformer game layer out of the committed v3
 * envelope fixtures (and the storage-v3 demo project), through the product.
 *
 * Phase 24 removed `content.game` (the key stays and is null), the
 * `cameraFollow` and `gameZone` components. For every kept envelope:
 * `content.game` → null (an absent key stays absent), both components are
 * dropped from their entities (entity order and ids unchanged, so every
 * recorded entity path still holds) and the entity names that named the
 * removed layer are neutral. A valid envelope is written as the product's
 * canonical form (`normalizeEnvelopeV3`) and must validate; an invalid one
 * must still fail with the code/path/reason its index row records. The
 * invalid envelopes whose subject is the removed layer are deleted with their
 * index rows. Then the bytes/sha256 rows of both index.json files are
 * recomputed. Idempotent.
 *
 * Run: npx tsx fixtures/m3/contracts/tools/remove-game-layer.mts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeEnvelopeV3, validateEnvelopeV3, validateSceneV3 } from '@thirdlight/project-model';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = join(CONTRACTS, '..', 'storage');
const canon = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Invalid envelopes whose subject is the removed game layer. */
const REMOVED = [
  'envelope/invalid/checkpoint-missing-safespawn.json',
  'envelope/invalid/cue-kind-mismatch.json',
  'envelope/invalid/cue-unresolved.json',
  'envelope/invalid/game-dangling-player.json',
  'envelope/invalid/game-extra-field.json',
  'envelope/invalid/game-instructions-too-long.json',
  'envelope/invalid/game-kill-above-max.json',
  'envelope/invalid/game-missing-key.json',
  'envelope/invalid/game-no-goal.json',
  'envelope/invalid/game-two-checkpoints.json',
  'envelope/invalid/zone-parented.json',
];
/** Entity names that named the removed layer → neutral names. */
const NAMES: Record<string, string> = { Beacon: 'Marker', 'Mid checkpoint': 'Mid marker', 'Checkpoint spawn': 'Second spawn' };

type Entity = { name?: string; components: Record<string, unknown> };
function neutralScene(scene: { entities: Entity[] }): void {
  for (const e of scene.entities) {
    delete e.components['cameraFollow'];
    delete e.components['gameZone'];
    if (e.name !== undefined && NAMES[e.name] !== undefined) e.name = NAMES[e.name];
  }
}
function neutralEnvelope(env: { scene: { entities: Entity[] }; content: Record<string, unknown> }): void {
  neutralScene(env.scene);
  if ('game' in env.content) env.content['game'] = null;
}

type IndexRow = { sha256: string; bytes: number; kind: string; expect?: { result: string; path: string; reason?: string } };
const index = JSON.parse(readFileSync(join(CONTRACTS, 'index.json'), 'utf8')) as { fixtures: Record<string, IndexRow> };

for (const rel of REMOVED) {
  rmSync(join(CONTRACTS, rel), { force: true });
  delete index.fixtures[rel];
}

for (const [rel, row] of Object.entries(index.fixtures)) {
  if (!rel.startsWith('envelope/')) continue;
  const env = JSON.parse(readFileSync(join(CONTRACTS, rel), 'utf8'));
  neutralEnvelope(env);
  if (row.kind === 'v3-envelope-valid') {
    const n = normalizeEnvelopeV3(env);
    if (!n.ok) throw new Error(`${rel}: ${JSON.stringify(n.errors[0])}`);
    const text = canon(n.normalized);
    if (text !== canon(env)) throw new Error(`${rel}: the neutral envelope is not in canonical form`);
    writeFileSync(join(CONTRACTS, rel), text);
  } else {
    const res = validateEnvelopeV3(env);
    const want = row.expect!;
    const got = res.ok ? null : (res.errors[0] as { code: string; path: string; reason?: string });
    // The two version-combination fixtures whose scene is not v3 are refused before the scene is read.
    if (got === null || got.code !== want.result || got.path !== want.path || (want.reason !== undefined && got.reason !== want.reason)) {
      throw new Error(`${rel}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    writeFileSync(join(CONTRACTS, rel), canon(env));
  }
}

for (const [rel, row] of Object.entries(index.fixtures)) {
  if (!existsSync(join(CONTRACTS, rel))) throw new Error(`index row without a file: ${rel}`);
  const bytes = readFileSync(join(CONTRACTS, rel));
  row.bytes = bytes.length;
  row.sha256 = sha256(bytes);
}
writeFileSync(join(CONTRACTS, 'index.json'), canon(index));

// The storage-v3 demo project (packet 46): its scene document.
const mainRel = 'project-v3-demo-0003/scenes/main.json';
const main = JSON.parse(readFileSync(join(STORAGE, mainRel), 'utf8'));
neutralEnvelope(main);
const scene = validateSceneV3(main.scene);
if (!scene.ok) throw new Error(`storage ${mainRel}: ${JSON.stringify(scene.errors[0])}`);
const envRes = validateEnvelopeV3(main);
if (!envRes.ok) throw new Error(`storage ${mainRel}: ${JSON.stringify(envRes.errors[0])}`);
writeFileSync(join(STORAGE, mainRel), canon(main));
const storageIndex = JSON.parse(readFileSync(join(STORAGE, 'index.json'), 'utf8')) as { files: Record<string, { sha256: string; bytes: number }> };
for (const [rel, row] of Object.entries(storageIndex.files)) {
  const bytes = readFileSync(join(STORAGE, rel));
  row.bytes = bytes.length;
  row.sha256 = sha256(bytes);
}
writeFileSync(join(STORAGE, 'index.json'), canon(storageIndex));
console.log(`removed ${REMOVED.length} envelopes; rewrote ${Object.keys(index.fixtures).filter((r) => r.startsWith('envelope/')).length} envelopes, ${mainRel} and both index.json files`);
