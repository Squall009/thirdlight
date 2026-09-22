/**
 * Packet 69 — the deterministic GLB source builder (committed fixture
 * bytes, no dependency).
 *
 * WHY PACKET-OWNED BYTES: the template/sample source `courier.glb`
 * (`samples/beacon-reach/assets/model/courier.glb`, copied byte-identically
 * into `fixtures/m4/templates/templates/platformer-starter/sources/model/`)
 * carries CORRUPTED animation data: its sampler `input` accessors are
 * miswired by the sample generator (`samples/beacon-reach/tools/
 * generate-assets.mjs` — the `tAcc = 3 + samplers.length * 2` accessor
 * index collides with the part-index accessors), so every clip track's
 * "key times" resolve to a box's 36 vertex indices (values 0..7,
 * non-monotonic). The committed file therefore fails the accepted
 * substrate validation with `asset_clip_invalid` ("clip 0 carries
 * non-finite or non-monotonic key times" — 79 non-monotonic transitions
 * of 179 per track). The sample is static-only in M3 (no modelAnimation
 * binding), so the defect was latent until the M4 template binds the
 * clips. The repair belongs to the owning packets (the sample / template
 * fixtures); packet 69 documents the defect (the fixture index's
 * `sourceSubstitution` block) and uses packet-owned GLB bytes of the
 * SAME structure (same clip names/order/channels, 4 s duration) for the
 * `tests/integration/m4-render` evidence — the scene document and the
 * committed clip bindings are unchanged.
 *
 * Structure (mirrors the sample's rigid multi-part model):
 *   Root
 *   ├─ Body  (box mesh, gray) — static
 *   └─ Arm   (box mesh, amber) — animated
 *   clips (4.0 s, 9 keyframes at 0.5 s):
 *     Idle      — Arm.quaternion only (a gentle in-place sway)
 *     Run       — Arm.quaternion + Arm.position (a full swing: the arm
 *                 ROTATES AND TRANSLATES — the visible run motion)
 *     Airborne  — Arm.quaternion + Arm.position (the arm lifted)
 */
export class BinWriter {
  private bytes: number[] = [];
  push(data: Uint8Array): { offset: number; length: number } {
    const offset = Math.ceil(this.bytes.length / 4) * 4;
    while (this.bytes.length < offset) this.bytes.push(0);
    for (let i = 0; i < data.length; i += 1) this.bytes.push(data[i] & 0xff);
    return { offset, length: data.length };
  }
  byteLength(): number {
    return this.bytes.length;
  }
  padded(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bytes.length / 4) * 4);
    out.set(Uint8Array.from(this.bytes), 0);
    return out;
  }
}

function f32(values: number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 4);
  const v = new DataView(buf);
  values.forEach((x, i) => v.setFloat32(i * 4, x, true));
  return new Uint8Array(buf);
}
function u16(values: number[]): Uint8Array {
  const buf = new ArrayBuffer(values.length * 2);
  const v = new DataView(buf);
  values.forEach((x, i) => v.setUint16(i * 2, x, true));
  return new Uint8Array(buf);
}

/** A unit box (8 vertices, 12 triangles). */
function boxBytes(halfX: number, halfY: number, halfZ: number): { positions: Uint8Array; indices: Uint8Array } {
  const x = halfX, y = halfY, z = halfZ;
  return {
    positions: f32([
      -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z,
      -x, -y, z, x, -y, z, x, y, z, -x, y, z,
    ]),
    indices: u16([
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
      0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
      3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
    ]),
  };
}

/** Pack a glTF 2.0 GLB (JSON chunk + BIN chunk). */
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

interface ClipSpec {
  name: string;
  /** X-axis rotation angle (rad) at each of the 9 keyframes. */
  rotation: number[];
  /** Arm translation (x, y, z) at each of the 9 keyframes, or null. */
  translation: number[][] | null;
}

const DURATION = 4.0;
const KEYS = 9;
const KEY_TIMES: number[] = Array.from({ length: KEYS }, (_, i) => Number(((i * DURATION) / (KEYS - 1)).toFixed(4)));
/** The times must be strictly monotonic (the substrate's clip check). */
for (let i = 1; i < KEY_TIMES.length; i += 1) {
  if (!(KEY_TIMES[i] > KEY_TIMES[i - 1])) throw new Error('non-monotonic key times (generator invariant)');
}

function quaternionX(angle: number): number[] {
  return [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
}
/** Quaternion track output: 9 keyframes × 4 components. */
function rotationValues(rotation: number[]): number[] {
  const out: number[] = [];
  for (const a of rotation) out.push(...quaternionX(a));
  return out;
}
/** Translation track output: 9 keyframes × 3 components. */
function translationValues(translation: number[][]): number[] {
  const out: number[] = [];
  for (const t of translation) out.push(t[0], t[1], t[2]);
  return out;
}

/** The shared courier/beacon model: Root → Body (static) + Arm (animated). */
function buildRigidModel(
  generator: string,
  parts: Array<{ name: string; half: [number, number, number]; translation: [number, number, number]; color: [number, number, number] }>,
  clips: ClipSpec[],
): Uint8Array {
  const bin = new BinWriter();
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  const materials: unknown[] = [];
  const animations: unknown[] = [];

  parts.forEach((p, i) => {
    const box = boxBytes(p.half[0], p.half[1], p.half[2]);
    const pos = bin.push(box.positions);
    const idx = bin.push(box.indices);
    bufferViews.push({ buffer: 0, byteOffset: pos.offset, byteLength: pos.length, target: 34962 });
    bufferViews.push({ buffer: 0, byteOffset: idx.offset, byteLength: idx.length, target: 34963 });
    const [hx, hy, hz] = p.half;
    accessors.push({
      bufferView: 2 * i, componentType: 5126, count: 8, type: 'VEC3',
      min: [-hx, -hy, -hz], max: [hx, hy, hz],
    });
    accessors.push({ bufferView: 2 * i + 1, componentType: 5123, count: 36, type: 'SCALAR' });
    meshes.push({
      name: `${p.name}Mesh`,
      primitives: [{ attributes: { POSITION: 2 * i }, indices: 2 * i + 1, material: i, mode: 4 }],
    });
    materials.push({
      name: `${p.name}Mat`,
      pbrMetallicRoughness: { baseColorFactor: [p.color[0], p.color[1], p.color[2], 1], metallicFactor: 0.1, roughnessFactor: 0.8 },
    });
    nodes.push({ name: p.name, mesh: i, translation: p.translation });
  });

  nodes.unshift({ name: 'Root', children: parts.map((_, i) => i + 1) });
  // The animation accessors start AFTER the mesh accessors (2 per part) —
  // the sample generator's off-by-part-count collision is the documented
  // defect this builder does not repeat.
  let nextAccessor = 2 * parts.length;

  for (const clip of clips) {
    const samplers: unknown[] = [];
    const channels: unknown[] = [];
    // The arm is the last part (index parts.length - 1 → node index
    // parts.length). Only the Arm is animated (the Body stays static).
    const armNodeIndex = parts.length;
    if (clip.rotation !== undefined) {
      const t = bin.push(f32(KEY_TIMES));
      bufferViews.push({ buffer: 0, byteOffset: t.offset, byteLength: t.length, target: 34962 });
      const tAcc = nextAccessor;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: KEYS, type: 'SCALAR', min: [KEY_TIMES[0]], max: [KEY_TIMES[KEYS - 1]] });
      const r = bin.push(f32(rotationValues(clip.rotation)));
      bufferViews.push({ buffer: 0, byteOffset: r.offset, byteLength: r.length, target: 34962 });
      const rAcc = nextAccessor + 1;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: KEYS, type: 'VEC4' });
      samplers.push({ input: tAcc, output: rAcc, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: armNodeIndex, path: 'rotation' } });
      nextAccessor = rAcc + 1;
    }
    if (clip.translation !== null && clip.translation !== undefined) {
      const t = bin.push(f32(KEY_TIMES));
      bufferViews.push({ buffer: 0, byteOffset: t.offset, byteLength: t.length, target: 34962 });
      const tAcc = nextAccessor;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: KEYS, type: 'SCALAR', min: [KEY_TIMES[0]], max: [KEY_TIMES[KEYS - 1]] });
      const tr = bin.push(f32(translationValues(clip.translation)));
      bufferViews.push({ buffer: 0, byteOffset: tr.offset, byteLength: tr.length, target: 34962 });
      const trAcc = nextAccessor + 1;
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: KEYS, type: 'VEC3' });
      samplers.push({ input: tAcc, output: trAcc, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: armNodeIndex, path: 'translation' } });
      nextAccessor = trAcc + 1;
    }
    animations.push({ name: clip.name, samplers, channels });
  }

  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength() }],
    animations,
  };
  return packGlb(JSON.stringify(json), bin.padded());
}

const sin = (phase: number): number => Math.sin(Math.PI * 2 * phase);

/** The courier: the Idle clip rotates the arm in place (quaternion
 * channel only); Run and Airborne carry quaternion + translation (the arm
 * swings — the visible distinct motion). */
export function buildCourierGlb(): Uint8Array {
  const parts: Array<{ name: string; half: [number, number, number]; translation: [number, number, number]; color: [number, number, number] }> = [
    { name: 'Body', half: [0.25, 0.5, 0.15], translation: [0, 0.5, 0], color: [0.55, 0.58, 0.62] },
    { name: 'Arm', half: [0.08, 0.28, 0.08], translation: [0.32, 0.85, 0], color: [0.85, 0.65, 0.2] },
  ];
  const sway = Array.from({ length: KEYS }, (_, i) => 0.18 * sin(i / 4));
  const swing = Array.from({ length: KEYS }, (_, i) => 0.9 * sin(i / 2));
  const swingPos = Array.from({ length: KEYS }, (_, i) => [0.32 + 0.22 * sin(i / 2), 0.85, 0.18 * sin(i / 2)] as [number, number, number]);
  const lift = Array.from({ length: KEYS }, (_, i) => 0.5 * sin(i / 4));
  const liftPos = Array.from({ length: KEYS }, (_, i) => [0.32 - 0.1 * sin(i / 4), 0.85 + 0.25 * (1 - Math.cos(Math.PI * 2 * (i / 4))) / 2, 0] as [number, number, number]);
  const clips: ClipSpec[] = [
    { name: 'Idle', rotation: sway, translation: null },
    { name: 'Run', rotation: swing, translation: swingPos },
    { name: 'Airborne', rotation: lift, translation: liftPos },
  ];
  return buildRigidModel('thirdlight-m4-69-fixture-generator', parts, clips);
}

/** The beacon: a single static box (no animation — the static-model path). */
export function buildBeaconGlb(): Uint8Array {
  const parts: Array<{ name: string; half: [number, number, number]; translation: [number, number, number]; color: [number, number, number] }> = [
    { name: 'Body', half: [0.3, 0.6, 0.3], translation: [0, 0.6, 0], color: [0.3, 0.75, 0.7] },
  ];
  return buildRigidModel('thirdlight-m4-69-fixture-generator', parts, []);
}