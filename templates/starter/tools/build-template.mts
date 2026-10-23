/**
 * The neutral starter template (phase 24.2): a ground, a few boxes, a
 * spawn point, a camera, two lights, a character with the controller and a
 * decoration model. No game rules: no game block, no zones, no pickups, no
 * enemies. A project made from it plays in scene mode (the scene as
 * authored, the character driven by the controller).
 *
 * The script (1) writes the template's self-generated pillar (a small rigid
 * GLB, no downloaded content) and the provenance of both models — the
 * character is a game-ready file made in Blender by the art pipeline
 * (`assets/model/character.glb`, kept in the repository; read, never
 * written here) — and (2) authors
 * the scene through the real editing path (`@thirdlight/commands`
 * `applyMutation`, the same commands the browser and MCP use) and captures
 * the result as `captured/project.json`, with the command list in
 * `recipe/commands.json`. Re-running it gives the same bytes.
 *
 * Run:
 *   npx esbuild templates/starter/tools/build-template.mts --bundle --platform=node \
 *     --format=esm --outfile=$HOME/.cache/tmp/tl-starter.mjs && node $HOME/.cache/tmp/tl-starter.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { inspectGlb } from '@thirdlight/asset-pipeline';

import { capture, newAuthor, run } from '../../tools/author.mts';

// Bundled outside the repository, so the template folder comes from the working directory (the repo root).
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

const T = (x: number, y: number): Record<string, unknown> => ({ position: [x, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const solid = (name: string, x: number, y: number, w: number, h: number, color: string): Record<string, unknown> => ({
  kind: 'box',
  name,
  transform: T(x, y),
  box: { size: [w, h, 1], material: { color } },
  components: { collider: { shape: { type: 'box', hx: w / 2, hy: h / 2 } } },
});

/** A file's import record as the engine's own GLB inspection proposes it (metrics, bounds, used extensions). */
function inspected(bytes: Uint8Array, displayName: string): { importRecipe: Record<string, unknown>; metrics: Record<string, unknown> } {
  const recipe = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } } as const;
  const p = inspectGlb(bytes, { ...recipe, displayName });
  if (p.status !== 'ok' || !('metrics' in p)) throw new Error(`${displayName}: the import inspection refused it: ${JSON.stringify(p.diagnostics)}`);
  return { importRecipe: { ...p.importRecipe }, metrics: { ...p.metrics } };
}

function main(): void {
  mkdirSync(join(ASSETS, 'model'), { recursive: true });
  const character = new Uint8Array(readFileSync(join(ASSETS, 'model', 'character.glb')));
  const pillar = { importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] }, metrics: glbMetrics(PILLAR) };
  const models = [
    // The controller's roles: Idle 0, Run 1, Airborne 2 (Walk 3, Jump 4 and Land 5 are there for a game's own animator).
    { assetId: 'starter-character', displayName: 'Character', path: 'model/character.glb', bytes: character, clips: ['Idle', 'Run', 'Airborne', 'Walk', 'Jump', 'Land'], made: 'Blender (art pipeline): LOD0–2 and a capsule _COL, KTX2 textures, 22-bone skin', ...inspected(character, 'Character') },
    { assetId: 'starter-pillar', displayName: 'Pillar', path: 'model/pillar.glb', bytes: PILLAR, clips: [] as string[], made: 'this script', ...pillar },
  ];
  writeFileSync(join(ASSETS, 'model', 'pillar.glb'), PILLAR);
  writeFileSync(
    join(ASSETS, 'provenance.json'),
    JSON.stringify(
      {
        template: PROJECT_ID,
        generatedBy: 'templates/starter/tools/build-template.mts',
        note: 'Original content (the pillar generated by the script above, the character made in Blender for this template); no downloaded or third-party content.',
        assets: models.map((m) => ({ id: m.assetId, kind: 'model', path: m.path, madeBy: m.made, sourceDigest: sha256Hex(m.bytes), sourceByteLength: m.bytes.byteLength, profile: 'glb-gltf2', triangles: m.metrics['triangles'], clips: m.clips })),
      },
      null,
      2,
    ) + '\n',
  );

  // The baseline is a new project's scene: its default camera 12 m in front of the z = 0 plane.
  const author = newAuthor(PROJECT_ID, [4, 3, 12]);
  for (const m of models) {
    run(author, 'publishAsset', {
      mode: 'create',
      assetId: m.assetId,
      kind: 'model',
      displayName: m.displayName,
      sourceDigest: sha256Hex(m.bytes),
      sourceByteLength: m.bytes.byteLength,
      importRecipe: m.importRecipe,
      metrics: m.metrics,
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

  capture(author, ROOT, 'templates/starter/tools/build-template.mts', IMPORTED_AT);
  for (const m of models) console.log(`  ${m.path}: ${m.bytes.byteLength} B, ${JSON.stringify(m.metrics)}`);
}

main();
