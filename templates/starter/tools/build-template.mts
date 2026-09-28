/**
 * The neutral starter template (phase 24.2): a ground, a few boxes, a
 * spawn point, a camera, two lights, a character with the controller and a
 * decoration model. No game rules: no game block, no zones, no pickups, no
 * enemies. A project made from it plays in scene mode (the scene as
 * authored, the character driven by the controller).
 *
 * The script (1) writes the template's self-generated assets (two small
 * rigid GLBs, no downloaded content) and their provenance, and (2) authors
 * the scene through the real editing path (`@thirdlight/commands`
 * `applyMutation`, the same commands the browser and MCP use) and captures
 * the result as `captured/project.json`, with the command list in
 * `recipe/commands.json`. Re-running it gives the same bytes.
 *
 * Run:
 *   npx esbuild templates/starter/tools/build-template.mts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/tl-starter.mjs && node /tmp/tl-starter.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { applyMutation, createCommandState } from '@thirdlight/commands';
import type { CommandState, MutationSuccess } from '@thirdlight/commands';
import type { SceneV3 } from '@thirdlight/project-model';

// Bundled to /tmp, so the template folder comes from the working directory (the repo root).
const ROOT = resolve('templates', 'starter');
const ASSETS = join(ROOT, 'assets');
const PROJECT_ID = 'starter';
const IMPORTED_AT = '2026-09-28T00:00:00Z';

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* ---------------------------------------------------------------- GLB --- */

class BinWriter {
  bytes: number[] = [];
  push(data: number[]): { offset: number; length: number } {
    const offset = Math.ceil(this.bytes.length / 4) * 4;
    while (this.bytes.length < offset) this.bytes.push(0);
    for (const b of data) this.bytes.push(b & 0xff);
    return { offset, length: data.length };
  }
  padded(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bytes.length / 4) * 4);
    out.set(this.bytes, 0);
    return out;
  }
}

function f32(values: number[]): number[] {
  const v = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((x, i) => v.setFloat32(i * 4, x, true));
  return [...new Uint8Array(v.buffer)];
}
function u16(values: number[]): number[] {
  const v = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((x, i) => v.setUint16(i * 2, x, true));
  return [...new Uint8Array(v.buffer)];
}

function packGlb(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4);
  jsonPadded.set(jsonBytes, 0);
  jsonPadded.fill(0x20, jsonBytes.length);
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonPadded.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  v.setUint32(binHeader, bin.length, true);
  v.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

interface Part { name: string; half: [number, number, number]; translation: [number, number, number]; color: [number, number, number, number] }
interface Clip { name: string; duration: number; perPart: Record<string, { rot?: [number, number, number, number]; trans?: [number, number, number] }> }

/**
 * A rigid multi-part model: one box mesh per part on its own node under a
 * root, and named two-key clips per part. Each box is 24 vertices (flat
 * normals per face) and 12 triangles.
 */
function buildRigidModel(sceneName: string, parts: Part[], clips: Clip[], rootTranslation?: [number, number, number]): Uint8Array {
  const bin = new BinWriter();
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [{ name: 'Root', children: parts.map((_, i) => i + 1), ...(rootTranslation ? { translation: rootTranslation } : {}) }];
  const view = (data: number[], target?: number): number => {
    const r = bin.push(data);
    bufferViews.push({ buffer: 0, byteOffset: r.offset, byteLength: r.length, ...(target !== undefined ? { target } : {}) });
    return bufferViews.length - 1;
  };
  for (const [i, p] of parts.entries()) {
    const [x, y, z] = p.half;
    // Six faces, four vertices each: [normal, u axis, v axis].
    const faces: Array<[number[], number[], number[]]> = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (const [n, u, v] of faces) {
      const base = pos.length / 3;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        pos.push((n[0]! + su * u[0]! + sv * v[0]!) * x, (n[1]! + su * u[1]! + sv * v[1]!) * y, (n[2]! + su * u[2]! + sv * v[2]!) * z);
        nor.push(n[0]!, n[1]!, n[2]!);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const posAcc = accessors.length;
    accessors.push({ bufferView: view(f32(pos), 34962), componentType: 5126, count: 24, type: 'VEC3', min: [-x, -y, -z], max: [x, y, z] });
    accessors.push({ bufferView: view(f32(nor), 34962), componentType: 5126, count: 24, type: 'VEC3' });
    accessors.push({ bufferView: view(u16(idx), 34963), componentType: 5123, count: 36, type: 'SCALAR' });
    meshes.push({ name: `${p.name}Mesh`, primitives: [{ attributes: { POSITION: posAcc, NORMAL: posAcc + 1 }, indices: posAcc + 2, material: i, mode: 4 }] });
    materials.push({ name: `${p.name}Mat`, pbrMetallicRoughness: { baseColorFactor: p.color, metallicFactor: 0.1, roughnessFactor: 0.8 } });
    nodes.push({ name: p.name, mesh: i, translation: p.translation });
  }
  const animations = clips.map((clip) => {
    const samplers: Record<string, unknown>[] = [];
    const channels: Record<string, unknown>[] = [];
    for (const [partName, spec] of Object.entries(clip.perPart)) {
      const node = parts.findIndex((p) => p.name === partName) + 1;
      const times = accessors.length;
      accessors.push({ bufferView: view(f32([0, clip.duration])), componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [clip.duration] });
      if (spec.rot) {
        const [qx, qy, qz, qw] = spec.rot;
        const n = Math.hypot(qx, qy, qz, qw);
        accessors.push({ bufferView: view(f32([0, 0, 0, 1, qx / n, qy / n, qz / n, qw / n])), componentType: 5126, count: 2, type: 'VEC4' });
        samplers.push({ input: times, output: accessors.length - 1, interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });
      }
      if (spec.trans) {
        const t0 = parts[node - 1]!.translation;
        accessors.push({ bufferView: view(f32([...t0, t0[0] + spec.trans[0], t0[1] + spec.trans[1], t0[2] + spec.trans[2]])), componentType: 5126, count: 2, type: 'VEC3' });
        samplers.push({ input: times, output: accessors.length - 1, interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node, path: 'translation' } });
      }
    }
    return { name: clip.name, samplers, channels };
  });
  const json = {
    asset: { version: '2.0', generator: 'thirdlight-starter-template' },
    scene: 0,
    scenes: [{ name: sceneName, nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.padded().length }],
    ...(animations.length > 0 ? { animations } : {}),
  };
  return packGlb(JSON.stringify(json), bin.padded());
}

// A blocky character sized to the 1.8 m controller capsule (an adult human).
// Its origin is the capsule centre, so the root sits 0.9 m lower: feet on the
// ground. Clips for the controller's locomotion roles: Idle, Run, Airborne.
const CHARACTER = buildRigidModel(
  'Character',
  [
    { name: 'Legs', half: [0.2, 0.3, 0.16], translation: [0, 0.3, 0], color: [0.3, 0.32, 0.38, 1] },
    { name: 'Body', half: [0.28, 0.42, 0.2], translation: [0, 1.02, 0], color: [0.55, 0.6, 0.66, 1] },
    { name: 'Head', half: [0.18, 0.18, 0.18], translation: [0, 1.62, 0], color: [0.8, 0.78, 0.74, 1] },
    { name: 'Arm', half: [0.08, 0.34, 0.08], translation: [0.36, 1.05, 0], color: [0.45, 0.5, 0.56, 1] },
  ],
  [
    { name: 'Idle', duration: 1.0, perPart: { Arm: { rot: [0, 0, 0.1, 0.995] } } },
    { name: 'Run', duration: 0.4, perPart: { Arm: { rot: [0.5, 0, 0, 0.866] }, Legs: { rot: [-0.2, 0, 0, 0.98] } } },
    { name: 'Airborne', duration: 0.6, perPart: { Arm: { rot: [0, 0, 0.7, 0.714] }, Legs: { trans: [0, 0.1, 0] } } },
  ],
  [0, -0.9, 0],
);

// A decoration: a 2 m pillar with a wider cap. No clips.
const PILLAR = buildRigidModel(
  'Pillar',
  [
    { name: 'Shaft', half: [0.3, 0.8, 0.3], translation: [0, 0.8, 0], color: [0.45, 0.45, 0.48, 1] },
    { name: 'Cap', half: [0.45, 0.2, 0.45], translation: [0, 1.8, 0], color: [0.6, 0.6, 0.62, 1] },
  ],
  [],
);

function glbMetrics(bytes: Uint8Array): Record<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as {
    nodes: unknown[]; meshes: Array<{ primitives: Array<{ attributes: { POSITION: number }; indices: number }> }>; materials: unknown[];
    accessors: Array<{ count: number }>; animations?: Array<{ channels: unknown[] }>;
  };
  let vertices = 0;
  let triangles = 0;
  for (const m of json.meshes) for (const p of m.primitives) {
    vertices += json.accessors[p.attributes.POSITION]!.count;
    triangles += json.accessors[p.indices]!.count / 3;
  }
  const binOffset = 20 + Math.ceil(jsonLen / 4) * 4 + 8;
  return {
    nodes: json.nodes.length,
    meshes: json.meshes.length,
    primitives: json.meshes.reduce((n, m) => n + m.primitives.length, 0),
    materials: json.materials.length,
    images: 0,
    textures: 0,
    vertices,
    triangles,
    animations: json.animations?.length ?? 0,
    animationChannels: (json.animations ?? []).reduce((n, a) => n + a.channels.length, 0),
    clipDurationMs: 0,
    decodedGeometryBytes: bytes.length - binOffset,
    decodedImageBytes: 0,
  };
}

/* ----------------------------------------------------------- authoring --- */

interface Author { state: CommandState; counter: number; applied: Array<{ op: string; args: Record<string, unknown> }> }

function run(author: Author, op: string, args: Record<string, unknown>): MutationSuccess {
  author.counter += 1;
  const revision = (author.state.scene as unknown as { revision: number }).revision;
  const outcome = applyMutation(author.state, { op, projectId: PROJECT_ID, expectedRevision: revision, requestId: `req-${author.counter.toString(16).padStart(32, '0')}`, args } as never);
  if (!outcome.ok) {
    console.error(`FAILED at ${op}:`, JSON.stringify(outcome.result, null, 2));
    process.exit(1);
  }
  author.state = outcome.state;
  author.applied.push({ op, args });
  return outcome.result as MutationSuccess;
}

const T = (x: number, y: number): Record<string, unknown> => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const solid = (name: string, x: number, y: number, w: number, h: number, color: string): Record<string, unknown> => ({
  kind: 'box',
  name,
  transform: T(x, y),
  box: { size: [w, h, 1], material: { color } },
  components: { collider: { shape: { type: 'box', hx: w / 2, hy: h / 2 } } },
});

function main(): void {
  mkdirSync(join(ASSETS, 'model'), { recursive: true });
  const models = [
    { assetId: 'starter-character', displayName: 'Character', path: 'model/character.glb', bytes: CHARACTER, clips: ['Idle', 'Run', 'Airborne'] },
    { assetId: 'starter-pillar', displayName: 'Pillar', path: 'model/pillar.glb', bytes: PILLAR, clips: [] as string[] },
  ];
  for (const m of models) writeFileSync(join(ASSETS, m.path), m.bytes);
  writeFileSync(
    join(ASSETS, 'provenance.json'),
    JSON.stringify(
      {
        template: PROJECT_ID,
        generatedBy: 'templates/starter/tools/build-template.mts',
        note: 'Original content generated by the script above; no downloaded or third-party content.',
        assets: models.map((m) => ({ id: m.assetId, kind: 'model', path: m.path, sourceDigest: sha256Hex(m.bytes), sourceByteLength: m.bytes.byteLength, profile: 'glb-gltf2', triangles: glbMetrics(m.bytes)['triangles'], clips: m.clips })),
      },
      null,
      2,
    ) + '\n',
  );

  // The baseline is a new project's scene: its one default camera (the v3
  // scene validator requires exactly one), 12 m in front of the z = 0 plane.
  const author: Author = {
    state: createCommandState(
      {
        schemaVersion: 3,
        sceneId: 'scene-main',
        revision: 0,
        entities: [{ id: 'cam-main', name: 'Main camera', components: { transform: { position: [4, 3, 12], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } }],
      } as unknown as SceneV3,
      { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null } as never,
    ),
    counter: 0,
    applied: [],
  };
  for (const m of models) {
    run(author, 'publishAsset', {
      mode: 'create',
      assetId: m.assetId,
      kind: 'model',
      displayName: m.displayName,
      sourceDigest: sha256Hex(m.bytes),
      sourceByteLength: m.bytes.byteLength,
      importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
      metrics: glbMetrics(m.bytes),
      importedAt: IMPORTED_AT,
    });
  }
  run(author, 'createEntity', solid('Ground', 8, -0.2, 24, 0.4, '#6f6f6f'));
  run(author, 'createEntity', solid('Step', 6.5, 0.1, 1, 0.4, '#7d7d7d'));
  run(author, 'createEntity', solid('Platform', 12, 1.6, 3, 0.4, '#7d7d7d'));
  run(author, 'createEntity', solid('Crate', -2, 0.5, 1, 1, '#8a7a62'));
  run(author, 'createEntity', {
    kind: 'model',
    name: 'Player',
    transform: T(3, 0.91),
    model: { asset: { assetId: 'starter-character' } },
    components: {
      controller: {},
      modelAnimation: {
        assetId: 'starter-character',
        version: 1,
        roles: { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } },
      },
    },
  });
  run(author, 'createEntity', { kind: 'group', name: 'Spawn', transform: T(3, 0.91), components: { playerSpawn: {} } });
  run(author, 'createEntity', { kind: 'group', name: 'Key light', transform: T(8, 10), components: { light: { type: 'directional', color: '#fff4e0', intensity: 1.6, direction: [0.4, -1, -0.6], castShadow: true } } });
  run(author, 'createEntity', { kind: 'group', name: 'Ambient fill', transform: T(0, 0), components: { light: { type: 'ambient', color: '#8a94b0', intensity: 0.9 } } });
  run(author, 'createEntity', { kind: 'model', name: 'Pillar', transform: T(17, 0), model: { asset: { assetId: 'starter-pillar' } } });

  const scene = author.state.scene as unknown as { revision: number; entities: Array<{ id: string; name: string }> };
  const captured = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: PROJECT_ID,
    scene: author.state.scene,
    content: (author.state as unknown as { content: unknown }).content,
    recipe: { generatedBy: 'templates/starter/tools/build-template.mts', commandCount: author.applied.length, importedAt: IMPORTED_AT },
  };
  mkdirSync(join(ROOT, 'captured'), { recursive: true });
  mkdirSync(join(ROOT, 'recipe'), { recursive: true });
  writeFileSync(join(ROOT, 'captured', 'project.json'), JSON.stringify(captured, null, 2) + '\n');
  writeFileSync(join(ROOT, 'recipe', 'commands.json'), JSON.stringify({ projectId: PROJECT_ID, importedAt: IMPORTED_AT, commands: author.applied }, null, 2) + '\n');
  console.log(`captured ${PROJECT_ID}: revision ${scene.revision}; ${scene.entities.map((e) => `${e.id} ${e.name}`).join(', ')}`);
  for (const m of models) console.log(`  ${m.path}: ${m.bytes.byteLength} B, ${JSON.stringify(glbMetrics(m.bytes))}`);
}

main();
