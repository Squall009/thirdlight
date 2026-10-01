/**
 * What a Play shows in place of an asset whose file is missing (one the start
 * scenes do not draw; see the closure's `placeholders`).
 *
 * Unity draws a missing mesh or shader in magenta, Godot shows a missing
 * texture as its error texture; a Play here does the same so a scene loaded
 * later shows where its files are missing instead of a hole:
 *
 * - a model: a magenta box the size of the model's recorded bounds (a unit
 *   box when none were recorded);
 * - a texture: a magenta and black checker;
 * - a sound: a moment of silence.
 *
 * A font has none (the build refuses; fonts are drawn by the project-wide
 * UI, so a missing one is always in the start's draw set anyway).
 */
import { encodeRgbaPng } from './image-thumbnail';

/** The placeholder texture's edge in pixels, and its checker cell. */
const TEXTURE_EDGE = 8;
const TEXTURE_CELL = 2;
/** The placeholder sound: 16-bit mono silence. */
const SILENCE_RATE = 8000;
const SILENCE_SAMPLES = 800;

const MAGENTA: readonly [number, number, number] = [1, 0, 1];

/** The bytes standing in for a missing asset of `kind`, or null (no placeholder for it). */
export function placeholderBytes(asset: { readonly kind: string; readonly bounds?: unknown }): Uint8Array | null {
  if (asset.kind === 'model') return boxGlb(boundsOf(asset.bounds));
  if (asset.kind === 'texture') return checkerPng();
  if (asset.kind === 'audio') return silenceWav();
  return null;
}

function boundsOf(raw: unknown): { min: [number, number, number]; max: [number, number, number] } {
  const b = raw as { min?: unknown; max?: unknown } | undefined;
  const ok = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (b !== undefined && ok(b.min) && ok(b.max)) {
    const { min, max } = b;
    if (min[0] < max[0] && min[1] < max[1] && min[2] < max[2]) return { min, max };
  }
  return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
}

function checkerPng(): Uint8Array {
  const rgba = new Uint8Array(TEXTURE_EDGE * TEXTURE_EDGE * 4);
  for (let y = 0; y < TEXTURE_EDGE; y += 1) {
    for (let x = 0; x < TEXTURE_EDGE; x += 1) {
      const on = (Math.floor(x / TEXTURE_CELL) + Math.floor(y / TEXTURE_CELL)) % 2 === 0;
      rgba.set(on ? [255, 0, 255, 255] : [0, 0, 0, 255], (y * TEXTURE_EDGE + x) * 4);
    }
  }
  return encodeRgbaPng(rgba, TEXTURE_EDGE, TEXTURE_EDGE);
}

function silenceWav(): Uint8Array {
  const data = SILENCE_SAMPLES * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SILENCE_RATE, true);
  v.setUint32(28, SILENCE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, data, true);
  return out;
}

/** A box from `min` to `max`: 24 vertices (flat normals), 36 indices, one magenta material. */
function boxGlb(b: { min: [number, number, number]; max: [number, number, number] }): Uint8Array {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  // Each face: its normal and its four corners (counter-clockwise seen from outside).
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);
  faces.forEach(([n, corners], f) => {
    corners.forEach((c, k) => {
      positions.set(c, (f * 4 + k) * 3);
      normals.set(n, (f * 4 + k) * 3);
    });
    indices.set([0, 1, 2, 0, 2, 3].map((i) => f * 4 + i), f * 6);
  });
  const bin = new Uint8Array(positions.byteLength + normals.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(normals.buffer), positions.byteLength);
  bin.set(new Uint8Array(indices.buffer), positions.byteLength + normals.byteLength);
  const gltf = {
    asset: { version: '2.0', generator: 'thirdlight placeholder' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Missing file', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Missing file', pbrMetallicRoughness: { baseColorFactor: [...MAGENTA, 1], metallicFactor: 0, roughnessFactor: 1 }, emissiveFactor: [...MAGENTA] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [x0, y0, z0], max: [x1, y1, z1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(bin.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jsonLength + 8 + binLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  v.setUint32(20 + jsonLength, binLength, true);
  v.setUint32(24 + jsonLength, 0x004e4942, true); // 'BIN\0'
  out.set(bin, 28 + jsonLength);
  return out;
}
