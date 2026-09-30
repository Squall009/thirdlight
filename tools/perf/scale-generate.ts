/**
 * The scale bench generator: a synthetic project of a full game's size,
 * written straight into the backend's on-disk project format
 * (`<dataRoot>/projects/<id>/`: project.json, content.json, scenes/*.json,
 * each prefab, material and dialogue its own file under `assets/<kind>/`,
 * each asset's record in its `.tlasset` sidecar,
 * and each asset a file under `assets/<kind>/` next to its `.tlasset`
 * sidecar), deterministic from a seed.
 *
 * Why files and not the command API: every command re-validates and rewrites
 * the whole content document, so building 26,000 asset records one command
 * at a time costs quadratic time (hours) before anything is measured, and the
 * count caps refuse the build long before the size the bench is for. Written
 * as files, the project is exactly what the backend would hold after those
 * imports: every asset record carries the proposal the backend's own
 * inspector (asset-pipeline) makes from the file's bytes, and opening the
 * project runs the model's full validation, so an open that the caps refuse
 * is itself a measurement.
 *
 * Content is neutral and generated: tones, noise textures, spheres, numbered
 * lines. Every file is distinct bytes (seeded), so nothing per file is hidden
 * by content addressing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIO_TOOLCHAIN,
  IMAGE_TOOLCHAIN,
  M2_GLTF_TOOLCHAIN,
  inspectAudio,
  inspectGlb,
  inspectImage,
} from '@thirdlight/asset-pipeline';

import { audioLoadOf } from '@thirdlight/project-model';
import { CONTENT_STORAGE_VERSION, defaultResourcePath, RESOURCE_KINDS, resourceFileBytes } from '@thirdlight/workspace';

import { sphereGlb } from './assets';
import { prng } from './generate';
import { opusVoice, pcmWav, scalePng } from './scale-media';

/** Bump when the generated content changes (it keys cached projects and recorded numbers). */
export const SCALE_GENERATOR_VERSION = 5;
export const SCALE_DEFAULT_SEED = 26;

export interface ScaleSpec {
  /** Voice lines (Ogg Opus, mono, 16 kbit/s), `voiceMinMs`..`voiceMaxMs` long. */
  voices: number;
  voiceMinMs: number;
  voiceMaxMs: number;
  /** Other sounds (PCM WAV mono 48 kHz, the one profile `audio` takes today), 0.2..1 s. */
  sounds: number;
  textures: number;
  /** Edge of every texture (px). */
  textureSize: number;
  models: number;
  prefabs: number;
  materials: number;
  scenes: number;
  /** Line nodes over every dialogue, each with a voice. */
  dialogueNodes: number;
  /** The first dialogue's lines (played through by the bench); its voices are `walkthroughVoiceMs` long. */
  walkthroughLines: number;
  walkthroughVoiceMs: number;
}

/** A full game's size (the plan's numbers). */
export const SCALE_FULL: Readonly<ScaleSpec> = Object.freeze({
  voices: 10_000,
  voiceMinMs: 1_000,
  voiceMaxMs: 15_000,
  sounds: 1_000,
  textures: 5_000,
  textureSize: 64,
  models: 2_000,
  prefabs: 5_000,
  materials: 2_000,
  scenes: 300,
  dialogueNodes: 2_000,
  walkthroughLines: 500,
  walkthroughVoiceMs: 1_000,
});

/**
 * The largest project today's per-project count caps accept: every kind at
 * its cap (voices are `music` records: 64; sounds `audio`: 64; models 128,
 * textures 256, prefabs 128, materials 256, scenes 64), dialogue lines
 * reusing the 64 voices, as many as the content document's byte cap leaves
 * room for.
 */
export const SCALE_AT_CAPS: Readonly<ScaleSpec> = Object.freeze({
  ...SCALE_FULL,
  voices: 64,
  sounds: 64,
  textures: 256,
  models: 128,
  prefabs: 128,
  materials: 256,
  scenes: 64,
  // The content block's 1 MiB cap binds before the dialogue caps do.
  dialogueNodes: 250,
});

/**
 * Half of `SCALE_AT_CAPS`: the Play and export manifest (256 KiB) refuses the
 * at-caps project, so the Play, walk, dialogue and export numbers at today's
 * limits are taken at this size.
 */
export const SCALE_HALF_CAPS: Readonly<ScaleSpec> = Object.freeze({
  ...SCALE_AT_CAPS,
  voices: 32,
  sounds: 32,
  textures: 128,
  models: 64,
  prefabs: 64,
  materials: 128,
  scenes: 32,
});

/** A few of each, for tests. */
export const SCALE_SMALL: Readonly<ScaleSpec> = Object.freeze({
  ...SCALE_FULL,
  voices: 24,
  voiceMaxMs: 3_000,
  sounds: 8,
  textures: 20,
  textureSize: 32,
  models: 8,
  prefabs: 16,
  materials: 8,
  scenes: 6,
  dialogueNodes: 24,
  walkthroughLines: 6,
  walkthroughVoiceMs: 400,
});

export const SCALE_PRESETS: Readonly<Record<string, Readonly<ScaleSpec>>> = { full: SCALE_FULL, caps: SCALE_AT_CAPS, 'half-caps': SCALE_HALF_CAPS, small: SCALE_SMALL };

/** The full size times `f` (at least one of each; the walkthrough and scene count kept usable). */
export function scaledSpec(f: number): ScaleSpec {
  const n = (v: number, min = 1): number => Math.max(min, Math.round(v * f));
  return {
    ...SCALE_FULL,
    voices: n(SCALE_FULL.voices),
    sounds: n(SCALE_FULL.sounds),
    textures: n(SCALE_FULL.textures),
    models: n(SCALE_FULL.models),
    prefabs: n(SCALE_FULL.prefabs),
    materials: n(SCALE_FULL.materials),
    scenes: n(SCALE_FULL.scenes, 2),
    dialogueNodes: n(SCALE_FULL.dialogueNodes),
    walkthroughLines: Math.min(SCALE_FULL.walkthroughLines, n(SCALE_FULL.dialogueNodes)),
  };
}

export interface ScaleResult {
  projectId: string;
  dir: string;
  spec: ScaleSpec;
  seed: number;
  /** Records per kind. */
  counts: Record<string, number>;
  /** Source bytes per asset kind (the files under assets/). */
  sourceBytes: Record<string, number>;
  contentJsonBytes: number;
  /** The resource files (prefabs, materials, dialogues), together. */
  resourceFileBytes?: number;
  /** The content block as the model measures it against its byte cap (canonical JSON, two-space indent). */
  contentCanonicalBytes: number;
  sceneFileBytes: number;
  /** Scene ids: [0] is the start scene; the rest load on demand. */
  sceneIds: string[];
  startSceneId: string;
  /** The dialogue the bench plays through, and its line count. */
  walkthrough: { dialogueId: string; lines: number; voices: string[] };
  /** The entity the bench attaches its script to (in the start scene). */
  driverEntityId: string;
  generateMs: number;
}

const IMPORTED_AT = '2026-01-01T00:00:00Z';
const pad = (i: number, w = 5): string => String(i).padStart(w, '0');
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const transform = (x: number, y: number, z: number): Record<string, unknown> => ({ position: [r3(x), r3(y), r3(z)], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const RETRY = { recordVersion: 2, retention: 128, records: [] };

/** The project-file layout the backend writes (objects indented, arrays of objects one per line). */
function layout(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((v) => v !== null && typeof v === 'object')) {
      const inner = `${indent}  `;
      return `[\n${value.map((v) => `${inner}${JSON.stringify(v)}`).join(',\n')}\n${indent}]`;
    }
    return JSON.stringify(value);
  }
  if (value !== null && typeof value === 'object') {
    const inner = `${indent}  `;
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${layout(v, inner)}`);
    return parts.length === 0 ? '{}' : `{\n${parts.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface Proposal {
  status: string;
  sourceDigest: string;
  sourceByteLength: number;
  importRecipe: unknown;
  metrics?: unknown;
  diagnostics: readonly { message: string }[];
}

/**
 * Write `<dataRoot>/projects/<projectId>/` for `spec` (replacing one that is
 * there). The backend must not hold the project while this runs.
 */
export function generateScaleProject(dataRoot: string, projectId: string, spec: ScaleSpec, seed = SCALE_DEFAULT_SEED, log: (s: string) => void = () => undefined): ScaleResult {
  const t0 = performance.now();
  const dir = join(dataRoot, 'projects', projectId);
  rmSync(dir, { recursive: true, force: true });
  for (const d of ['scenes', '.thirdlight/recovery']) mkdirSync(join(dir, d), { recursive: true });
  const EXT: Record<string, string> = { voice: 'opus', sound: 'wav', texture: 'png', model: 'glb' };
  const seen = new Set<string>();
  const sourceBytes: Record<string, number> = { voice: 0, sound: 0, texture: 0, model: 0 };
  const assets: Record<string, unknown>[] = [];
  const addAsset = (assetId: string, kind: 'audio' | 'texture' | 'model', displayName: string, bytes: Uint8Array, p: Proposal, bucket: string, options: Record<string, unknown> = {}): void => {
    if (p.status !== 'ok') throw new Error(`${assetId}: the ${kind} inspector refused the generated file: ${p.diagnostics.map((d) => d.message).join('; ')}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== p.sourceDigest) throw new Error(`${assetId}: digest mismatch`);
    if (seen.has(digest)) throw new Error(`${assetId}: two generated files have the same bytes (${digest})`);
    seen.add(digest);
    // The file in the game folder (a data-root project is its own) and its sidecar, as an import writes them.
    const sourcePath = `assets/${bucket}/${assetId}.${EXT[bucket]!}`;
    mkdirSync(join(dir, 'assets', bucket), { recursive: true });
    writeFileSync(join(dir, sourcePath), bytes);
    sourceBytes[bucket] = (sourceBytes[bucket] ?? 0) + bytes.length;
    const record = {
      assetId,
      kind,
      displayName,
      currentVersion: 1,
      versions: [{ version: 1, sourceDigest: digest, sourceByteLength: bytes.length, sourcePath, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: IMPORTED_AT, publishedRevision: 0 }],
      ...options,
    };
    // The sidecar holds the record (the project reads its assets from the sidecars).
    writeFileSync(join(dir, `${sourcePath}.tlasset`), `${layout({ tlasset: 2, id: assetId, kind, importSettings: kind === 'audio' ? { ...audioLoadOf(record) } : {}, labels: [], address: null, record })}\n`);
    assets.push(record);
  };
  const rnd = prng(seed * 2654435761);
  const seedOf = (): number => Math.floor(rnd() * 2 ** 31);

  // Voices: the walkthrough's first, short; the rest spread over min..max.
  const voiceIds: string[] = [];
  for (let i = 0; i < spec.voices; i++) {
    const id = `voice-${pad(i)}`;
    const ms = i < spec.walkthroughLines ? spec.walkthroughVoiceMs : spec.voiceMinMs + Math.floor(rnd() * (spec.voiceMaxMs - spec.voiceMinMs + 1));
    const bytes = opusVoice(seedOf(), ms, id);
    // A voiced game reads its lines when they are played, not with the scene (Unity: Preload Audio Data off).
    addAsset(id, 'audio', `Voice ${i}`, bytes, inspectAudio(bytes, { profile: 'audio', recipeVersion: 1, toolchain: AUDIO_TOOLCHAIN }) as unknown as Proposal, 'voice', { preload: false });
    voiceIds.push(id);
    if ((i + 1) % 2000 === 0) log(`scale: ${i + 1} voices`);
  }
  for (let i = 0; i < spec.sounds; i++) {
    const bytes = pcmWav(seedOf(), 200 + Math.floor(rnd() * 801));
    addAsset(`sound-${pad(i)}`, 'audio', `Sound ${i}`, bytes, inspectAudio(bytes, { profile: 'audio', recipeVersion: 1, toolchain: AUDIO_TOOLCHAIN }) as unknown as Proposal, 'sound');
  }
  const textureIds: string[] = [];
  for (let i = 0; i < spec.textures; i++) {
    const id = `texture-${pad(i)}`;
    const bytes = scalePng(seedOf(), spec.textureSize);
    addAsset(id, 'texture', `Texture ${i}`, bytes, inspectImage(bytes, { profile: 'image', recipeVersion: 1, toolchain: IMAGE_TOOLCHAIN }) as unknown as Proposal, 'texture');
    textureIds.push(id);
  }
  log(`scale: ${spec.sounds} sounds, ${spec.textures} textures`);
  const modelIds: string[] = [];
  for (let i = 0; i < spec.models; i++) {
    const id = `model-${pad(i)}`;
    const bytes = sphereGlb(seedOf(), 6 + (i % 6), 8);
    addAsset(id, 'model', `Model ${i}`, bytes, inspectGlb(bytes, { profile: 'gltf-glb', recipeVersion: 1, toolchain: M2_GLTF_TOOLCHAIN }) as unknown as Proposal, 'model');
    modelIds.push(id);
  }
  log(`scale: ${spec.models} models`);
  assets.sort((a, b) => ((a['assetId'] as string) < (b['assetId'] as string) ? -1 : 1));

  // Materials: a base colour map each, normal maps and ORM maps over the rest of the textures.
  const materials = Array.from({ length: spec.materials }, (_, i) => {
    const textures: Record<string, string> = {};
    if (textureIds.length > 0) {
      textures['map'] = textureIds[i % textureIds.length]!;
      const n = spec.materials + i;
      if (n < textureIds.length) textures['normalMap'] = textureIds[n]!;
      const o = 2 * spec.materials + i;
      if (o < textureIds.length) textures['ormMap'] = textureIds[o]!;
    }
    return { materialId: `material-${pad(i)}`, name: `Material ${i}`, shader: 'standard', params: { roughness: r3(0.3 + rnd() * 0.7) }, textures };
  });
  const prefabs = Array.from({ length: spec.prefabs }, (_, i) => ({
    prefabId: `prefab-${pad(i)}`,
    displayName: `Prefab ${i}`,
    createdRevision: 0,
    entityCount: 1,
    depth: 1,
    entities: [
      {
        localId: 'root',
        name: `Prefab ${i}`,
        components: {
          transform: transform(0, 0, 0),
          model: { asset: { assetId: modelIds[i % modelIds.length]! } },
          ...(materials.length > 0 ? { materials: { '*': materials[i % materials.length]!.materialId } } : {}),
        },
      },
    ],
  }));

  // Dialogue: the walkthrough first (a chain of short voiced lines), then
  // dialogues of up to 50 lines until every line node is placed.
  const dialogues: Record<string, unknown>[] = [];
  let lineNo = 0;
  const chain = (dialogueId: string, name: string, lines: number, voiceAt: (k: number) => string): void => {
    const nodes: Record<string, unknown>[] = [{ id: 'start', type: 'start', position: [0, 0] }];
    const edges: Record<string, unknown>[] = [];
    let prev = 'start';
    for (let k = 0; k < lines; k++) {
      const id = `l${k}`;
      nodes.push({ id, type: 'line', position: [0, 100 * (k + 1)], data: { speaker: '', expression: 'neutral', text: `Line ${lineNo}.`, voice: voiceAt(k), auto: 'default' } });
      edges.push({ id: `e${k}`, from: { node: prev, port: 'next' }, to: { node: id, port: 'in' } });
      prev = id;
      lineNo += 1;
    }
    dialogues.push({ dialogueId, name, graph: { nodes, edges } });
  };
  const walkLines = Math.min(spec.walkthroughLines, spec.dialogueNodes);
  chain('walkthrough', 'Walkthrough', walkLines, (k) => voiceIds[k % voiceIds.length]!);
  let placed = walkLines;
  for (let d = 0; placed < spec.dialogueNodes; d++) {
    const lines = Math.min(50, spec.dialogueNodes - placed);
    const from = placed;
    chain(`dialogue-${pad(d, 4)}`, `Dialogue ${d}`, lines, (k) => voiceIds[(from + k) % voiceIds.length]!);
    placed += lines;
  }

  // Scenes: the start scene holds the camera, lights, a floor and the bench's
  // driver; every other scene holds the prefab copies dealt to it round robin.
  const sceneIds = Array.from({ length: spec.scenes }, (_, s) => `scene-${pad(s, 4)}`);
  const startSceneId = sceneIds[0]!;
  const driverEntityId = 'bench-driver';
  const sceneEntities: Record<string, unknown>[][] = sceneIds.map(() => []);
  sceneEntities[0]!.push(
    { id: 'cam-main', name: 'Camera', components: { transform: transform(0, 6, 18), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 200 } } },
    { id: 'light-0001', name: 'Sun', components: { transform: transform(0, 10, 0), light: { type: 'directional', color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3], castShadow: true } } },
    { id: 'light-0002', name: 'Ambient', components: { transform: transform(0, 0, 0), light: { type: 'ambient', color: '#8090a8', intensity: 0.6 } } },
    { id: 'floor', name: 'Floor', components: { transform: transform(0, -0.25, 0), box: { size: [60, 0.5, 60], material: { color: '#707070' } } } },
    { id: driverEntityId, name: 'Bench driver', components: { transform: transform(0, 0, 0) } },
  );
  const onDemand = Math.max(1, sceneIds.length - 1);
  for (let i = 0; i < prefabs.length; i++) {
    const s = sceneIds.length === 1 ? 0 : 1 + (i % onDemand);
    const list = sceneEntities[s]!;
    const k = list.length;
    const def = prefabs[i]!;
    const root = def.entities[0]!;
    list.push({
      id: `s${pad(s, 4)}-${pad(k, 4)}`,
      name: def.displayName,
      components: { ...root.components, transform: transform(-20 + (k % 8) * 5, 0, -(Math.floor(k / 8) * 5)), prefab: { prefabId: def.prefabId, localId: 'root' } },
    });
  }

  const content = {
    assets,
    prefabs,
    behaviors: [],
    settings: {},
    behaviorTrust: { entries: [] },
    scenes: sceneIds.map((sceneId, s) => ({ sceneId, name: s === 0 ? 'Start' : `Scene ${s}` })),
    startScenes: [startSceneId],
    materials,
    dialogues,
    // Lines advance on their voice's recorded length with no pause and no
    // typewriter, so any silence between two voices is the engine's.
    dialogueSettings: { textSpeed: 0, autoAdvance: true, autoDelay: 0 },
  };
  const manifest = { schemaVersion: 5, engineVersion: '0.1.0', id: projectId, name: `Scale bench ${projectId}`, createdAt: IMPORTED_AT };
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // content.json keeps the project-wide settings; each prefab, material and dialogue is its own file (as the backend writes them).
  const resources: Record<string, unknown[]> = { prefabs, materials, dialogues };
  let resourceBytes = 0;
  for (const k of RESOURCE_KINDS) {
    for (const record of (resources[k.list] ?? []) as Record<string, unknown>[]) {
      const id = String(record[k.idKey]);
      const path = defaultResourcePath(k, id);
      mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
      const bytes = resourceFileBytes(k, id, record);
      resourceBytes += bytes.length;
      writeFileSync(join(dir, ...path.split('/')), bytes);
    }
  }
  // Every asset has a file: its record is in its sidecar, not content.json.
  const wide = { ...Object.fromEntries(Object.entries(content).filter(([key]) => !RESOURCE_KINDS.some((k) => k.list === key))), assets: [] };
  const contentText = `${layout({ storageVersion: CONTENT_STORAGE_VERSION, type: 'project-content', projectId, revision: 0, content: wide, retry: RETRY })}\n`;
  writeFileSync(join(dir, 'content.json'), contentText);
  let sceneFileBytes = 0;
  sceneIds.forEach((sceneId, s) => {
    const text = `${layout({ storageVersion: 4, type: 'scene', projectId, scene: { schemaVersion: 4, sceneId, revision: 0, entities: sceneEntities[s] }, retry: RETRY })}\n`;
    sceneFileBytes += Buffer.byteLength(text);
    writeFileSync(join(dir, 'scenes', `${sceneId}.json`), text);
  });
  const counts = {
    voices: spec.voices,
    sounds: spec.sounds,
    textures: spec.textures,
    models: spec.models,
    prefabs: prefabs.length,
    materials: materials.length,
    scenes: sceneIds.length,
    dialogues: dialogues.length,
    dialogueLines: lineNo,
    assets: assets.length,
    sceneEntities: sceneEntities.reduce((n, l) => n + l.length, 0),
  };
  const result: ScaleResult = {
    projectId,
    dir,
    spec: { ...spec },
    seed,
    counts,
    sourceBytes,
    contentJsonBytes: Buffer.byteLength(contentText),
    resourceFileBytes: resourceBytes,
    contentCanonicalBytes: Buffer.byteLength(`${JSON.stringify(content, null, 2)}\n`),
    sceneFileBytes,
    sceneIds,
    startSceneId,
    walkthrough: { dialogueId: 'walkthrough', lines: walkLines, voices: Array.from({ length: walkLines }, (_, k) => voiceIds[k % voiceIds.length]!) },
    driverEntityId,
    generateMs: Math.round(performance.now() - t0),
  };
  log(`scale: ${projectId} written in ${result.generateMs} ms: content.json ${result.contentJsonBytes} B, sources ${Object.values(sourceBytes).reduce((a, b) => a + b, 0)} B`);
  return result;
}
