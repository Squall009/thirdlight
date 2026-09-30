/**
 * Shared helpers for the M3 build integration tests (B19/B21).
 *
 * Builders for minimal, SELF-CONTAINED container bytes (a valid glTF 2.0 GLB
 * and a valid RIFF/WAVE mono/48k/16-bit PCM WAV) so the M3 closure + export
 * tests can drive the real kind-tagged artifact path (model → `model/gltf-binary`,
 * audio → `audio/wav`) with digests that MATCH the emitted bytes. Node built-ins
 * are allowed here (this lives under `tests/`).
 */
import { createHash } from 'node:crypto';

/** Build one valid glTF 2.0 GLB (JSON chunk only — no external uris). */
export function minimalGlb(): Uint8Array {
  const jsonText = JSON.stringify({ asset: { version: '2.0', generator: 'thirdlight-m3-test' }, scenes: [{}], scene: 0 });
  const jsonUtf8 = new TextEncoder().encode(jsonText);
  // Pad the JSON chunk to a 4-byte boundary with spaces (0x20).
  let jsonPadded = jsonUtf8;
  while (jsonPadded.length % 4 !== 0) {
    const extra = new Uint8Array(4 - (jsonPadded.length % 4));
    extra.fill(0x20);
    jsonPadded = concatU8(jsonPadded, extra);
  }
  const totalLength = 12 + 8 + jsonPadded.length;
  const out = new Uint8Array(totalLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true); // version 2
  dv.setUint32(8, totalLength, true);
  dv.setUint32(12, jsonPadded.length, true); // chunk length
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonPadded, 20);
  return out;
}

/** Build one valid RIFF/WAVE mono/48000/16-bit PCM WAV with `frames` samples. */
export function minimalWav(frames = 96): Uint8Array {
  const dataBytes = frames * 2; // 16-bit mono
  const fmtSize = 16;
  const riffSize = 4 /*WAVE*/ + 8 /*fmt hdr*/ + fmtSize + 8 /*data hdr*/ + dataBytes;
  const total = 8 + riffSize;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  const tag = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) out[off + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, riffSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, fmtSize, true);
  dv.setUint16(20, 1, true); // audioFormat PCM
  dv.setUint16(22, 1, true); // channels mono
  dv.setUint32(24, 48000, true); // sampleRate
  dv.setUint32(28, 96000, true); // byteRate
  dv.setUint16(32, 2, true); // blockAlign
  dv.setUint16(34, 16, true); // bitsPerSample
  tag(36, 'data');
  dv.setUint32(40, dataBytes, true);
  // data bytes (zeros) already default.
  return out;
}

/** Concatenate two Uint8Arrays. */
function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The SHA-256 (lowercase hex) of the bytes (independent `node:crypto`). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A synthetic v3 authoring envelope (scene + content) with one model asset
 * and one audio asset, self-consistent digests. The model is reached through
 * the model/modelAnimation components; the audio through a declared `assetRef`
 * property of a declaration-only behavior on one entity. */
export function syntheticV3(): {
  scene: unknown;
  content: unknown;
  blobs: Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>;
} {
  const glb = minimalGlb();
  const wav = minimalWav();
  const glbDigest = sha256Hex(glb);
  const wavDigest = sha256Hex(wav);
  const blobs = new Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>([
    ['asset-model-player', { digest: glbDigest, byteLength: glb.length, bytes: glb }],
    ['asset-audio-start', { digest: wavDigest, byteLength: wav.length, bytes: wav }],
  ]);
  const T = { rotation: [0, 0, 0, 1] as number[], scale: [1, 1, 1] as number[] };
  const scene = {
    schemaVersion: 3,
    sceneId: 'scene-main',
    revision: 1,
    entities: [
      {
        id: 'cam-main',
        name: 'Gameplay camera',
        components: {
          transform: { position: [0, 4, 12], ...T },
          camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
        },
      },
      {
        id: 'model-0001',
        name: 'Player model',
        components: {
          transform: { position: [3, 0.91, 0], ...T },
          model: { asset: { assetId: 'asset-model-player' } },
          modelAnimation: {
            assetId: 'asset-model-player',
            version: 1,
            roles: { idle: { binding: 'test-idle' }, run: { binding: 'test-run' }, airborne: { binding: 'test-airborne' } },
          },
        },
      },
      { id: 'group-0001', name: 'Player', components: { transform: { position: [3, 0.9, 0], ...T }, controller: {} } },
      { id: 'spawn-0001', components: { transform: { position: [3, 0.91, 0], ...T }, playerSpawn: {} } },
      {
        id: 'sfx-0001',
        name: 'Start sound',
        components: {
          transform: { position: [3, 0, 0], ...T },
          behavior: { behaviorId: 'behavior-sfx', values: { sound: 'asset-audio-start' } },
        },
      },
      {
        id: 'static-0001',
        components: {
          transform: { position: [24, -0.25, 0], ...T },
          box: { size: [48, 0.5, 1], material: { color: '#6f6f6f' } },
          collider: { shape: { type: 'box', hx: 24, hy: 0.25 } },
        },
      },
    ],
  };
  const content = {
    assets: [
      {
        assetId: 'asset-model-player',
        kind: 'model',
        displayName: 'Player model',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            sourceDigest: glbDigest,
            sourceByteLength: glb.length,
            importRecipe: { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] },
            metrics: {
              nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 6, triangles: 2,
              animations: 3, animationChannels: 3, clipDurationMs: 900, decodedGeometryBytes: 1024, decodedImageBytes: 0,
            },
            importedAt: '2026-09-21T00:00:00Z',
            publishedRevision: 1,
          },
        ],
      },
      {
        assetId: 'asset-audio-start',
        kind: 'audio',
        displayName: 'Cue: Start',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            sourceDigest: wavDigest,
            sourceByteLength: wav.length,
            importRecipe: { profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } },
            metrics: { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 2 },
            importedAt: '2026-09-21T00:00:00Z',
            publishedRevision: 1,
          },
        ],
      },
    ],
    prefabs: [],
    behaviors: [
      {
        behaviorId: 'behavior-sfx',
        displayName: 'Start sound',
        declaration: { properties: [{ key: 'sound', label: 'Sound', type: 'assetRef', default: null }] },
        source: null,
        publishedRevision: 1,
      },
    ],
    settings: { run_speed: 6 },
    behaviorTrust: { entries: [] },
    game: null,
  };
  return { scene, content, blobs };
}

/** A fake workspace service for the M3 closure builder (the shared edge):
 * `query` (queryBehaviors) + `readBlob`. */
export function fakeService(opts?: {
  behaviors?: Array<Record<string, unknown>>;
  blobs?: Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>;
  blobError?: { code: string; cls: string; message: string };
  tamperDigest?: string;
  /** The revision the `queryProject` re-read returns (a late edit bumps this). */
  revision?: number;
}) {
  const behaviors = opts?.behaviors ?? [];
  const blobs = opts?.blobs;
  const revision = opts?.revision ?? 1;
  return {
    query: (q: { op: string }) => {
      if (q.op === 'queryBehaviors') {
        const a = (q as { args?: { limit?: number; offset?: number } }).args ?? {};
        const offset = a.offset ?? 0;
        return { ok: true, behaviors: behaviors.slice(offset, offset + (a.limit ?? 128)), total: behaviors.length, offset, limit: a.limit ?? 128 };
      }
      if (q.op === 'queryProject') return { ok: true, manifest: { revision }, revision };
      return { ok: true, manifest: { revision }, revision };
    },
    readBlob: (_projectId: string, req: { assetId: string; version: number }) => {
      if (opts?.blobError) return { ok: false, error: opts.blobError };
      const b = blobs?.get(req.assetId);
      if (b === undefined) return { ok: false, error: { code: 'blob_missing', cls: 'unavailable', message: `no blob for ${req.assetId}` } };
      const digest = opts?.tamperDigest ?? b.digest;
      return { ok: true, digest, byteLength: b.byteLength, bytes: b.bytes };
    },
    // Where each asset's bytes are (a Play build locates, the export reads); the same answers as readBlob.
    locateBlobs: (_projectId: string, reqs: readonly { assetId: string; version: number }[]) => ({
      ok: true,
      results: reqs.map((req) => {
        if (opts?.blobError) return { ok: false, error: opts.blobError };
        const b = blobs?.get(req.assetId);
        if (b === undefined) return { ok: false, error: { code: 'blob_missing', cls: 'unavailable', message: `no blob for ${req.assetId}` } };
        return { ok: true, assetId: req.assetId, version: req.version, file: { digest: opts?.tamperDigest ?? b.digest, byteLength: b.byteLength, real: `/fake/${req.assetId}` } };
      }),
    }),
  } as never;
}