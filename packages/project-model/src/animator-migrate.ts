/**
 * Phase 14.6: the old `modelAnimation` idle/run/airborne profile becomes an
 * animator controller when a v4 project is opened.
 *
 * Every distinct binding (asset, version and the three role clips) becomes
 * one controller named "Idle/run/airborne (<model>)" with the parameters the
 * player's animators get automatically (`speed`, `grounded`) and the old
 * fixed rule as transitions: airborne while not grounded, else run when the
 * speed is above 0.05 m/s, else idle, with the old 0.2 s crossfade; every
 * clip loops, as before. The entities (in scenes and prefabs) get
 * `animator {controller}` instead of `modelAnimation`. An entity that
 * already has an animator, or whose clips cannot be measured, keeps its old
 * component (it keeps playing) and is reported.
 *
 * Pure: the caller supplies the clip lengths (read from the model files).
 */
import type { AnimatorController } from './animator';
import type { ContentCatalogV4, SceneV4 } from './types-v3';

/** The old role rule's run threshold (m/s) and crossfade (s) — the three-adapter constants of packet 53. */
export const LEGACY_RUN_SPEED_EPS = 0.05;
export const LEGACY_CROSSFADE_SECONDS = 0.2;

const ROLES = ['idle', 'run', 'airborne'] as const;

interface LegacyBinding {
  assetId: string;
  version: number;
  roles: Record<(typeof ROLES)[number], { clipIndex?: unknown; clipName?: unknown }>;
}

export interface ModelAnimationMigration {
  scenes: SceneV4[];
  content: ContentCatalogV4;
  /** Entities moved to an animator (scene entities and prefab entities). */
  migrated: number;
  /** One line per controller made and per entity left as it was. */
  notes: string[];
}

/** The seconds of clip `clipIndex` (named `clipName`) of an asset version, or null when unknown. */
export type ClipDurationOf = (assetId: string, version: number, clipIndex: number, clipName: string) => number | null;

function bindingOf(v: unknown): LegacyBinding | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as { assetId?: unknown; version?: unknown; roles?: unknown };
  if (typeof b.assetId !== 'string' || typeof b.version !== 'number' || typeof b.roles !== 'object' || b.roles === null) return null;
  return b as LegacyBinding;
}

/**
 * Migrate every `modelAnimation` of a v4 project; null when there is none
 * (nothing to write).
 */
export function migrateModelAnimations(scenes: readonly SceneV4[], content: ContentCatalogV4, durationOf: ClipDurationOf): ModelAnimationMigration | null {
  type Holder = { components: Record<string, unknown> };
  const holders: { where: string; e: Holder }[] = [];
  for (const s of scenes) for (const e of s.entities) if ((e.components as Record<string, unknown>)['modelAnimation'] !== undefined) holders.push({ where: `entity ${e.id}`, e: e as unknown as Holder });
  for (const p of content.prefabs) {
    for (const e of p.entities as unknown as { localId?: string; components: Record<string, unknown> }[]) {
      if (e.components['modelAnimation'] !== undefined) holders.push({ where: `prefab ${p.prefabId} entity ${e.localId ?? '?'}`, e });
    }
  }
  if (holders.length === 0) return null;

  const next = structuredClone({ scenes: [...scenes], content }) as { scenes: SceneV4[]; content: ContentCatalogV4 };
  // Work on the copies (same order as `holders`).
  const copies: Holder[] = [];
  for (const s of next.scenes) for (const e of s.entities) if ((e.components as Record<string, unknown>)['modelAnimation'] !== undefined) copies.push(e as unknown as Holder);
  for (const p of next.content.prefabs) for (const e of p.entities as unknown as Holder[]) if (e.components['modelAnimation'] !== undefined) copies.push(e);

  const controllers = [...(next.content.animators ?? [])];
  const taken = new Set(controllers.map((c) => c.controllerId));
  const byKey = new Map<string, string>();
  const notes: string[] = [];
  let migrated = 0;
  holders.forEach((h, i) => {
    const e = copies[i]!;
    const b = bindingOf(e.components['modelAnimation']);
    if (b === null) return;
    if (e.components['animator'] !== undefined) {
      notes.push(`${h.where}: kept its idle/run/airborne animation (it already has an animator)`);
      return;
    }
    const key = JSON.stringify([b.assetId, b.version, ROLES.map((r) => [b.roles[r]?.clipIndex, b.roles[r]?.clipName])]);
    let id = byKey.get(key);
    if (id === undefined) {
      const clips: { name: string; duration: number }[] = [];
      for (const r of ROLES) {
        const role = b.roles[r];
        const name = typeof role?.clipName === 'string' ? role.clipName : null;
        const index = typeof role?.clipIndex === 'number' ? role.clipIndex : null;
        const d = name !== null && index !== null ? durationOf(b.assetId, b.version, index, name) : null;
        if (name === null || d === null || !(d > 0)) break;
        clips.push({ name, duration: Math.min(600, Math.max(0.001, d)) });
      }
      if (clips.length !== ROLES.length) {
        notes.push(`${h.where}: kept its idle/run/airborne animation (the clip lengths of ${b.assetId} could not be read)`);
        return;
      }
      for (let n = 1; ; n++) {
        const candidate = `idle-run-airborne-${String(n).padStart(2, '0')}`;
        if (!taken.has(candidate)) {
          id = candidate;
          break;
        }
      }
      taken.add(id);
      byKey.set(key, id);
      const model = next.content.assets.find((a) => a.assetId === b.assetId)?.displayName ?? b.assetId;
      const clip = (i: number) => ({ assetId: b.assetId, clip: clips[i]!.name, duration: clips[i]!.duration });
      // Phase 15.3: the project's animation blend time when it sets one (else the old 0.2 s).
      const set = (next.content.settings as Record<string, unknown> | undefined)?.['animation_crossfade_s'];
      const fade = typeof set === 'number' && Number.isFinite(set) ? set : LEGACY_CROSSFADE_SECONDS;
      const controller: AnimatorController = {
        controllerId: id,
        name: `Idle/run/airborne (${model})`.slice(0, 128),
        parameters: [
          { name: 'speed', type: 'float', default: 0 },
          { name: 'grounded', type: 'bool', default: true },
        ],
        states: [
          { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip(0) }, speed: 1, loop: true, position: [180, 40] },
          { id: 'run', name: 'Run', motion: { kind: 'clip', clip: clip(1) }, speed: 1, loop: true, position: [400, 40] },
          { id: 'airborne', name: 'Airborne', motion: { kind: 'clip', clip: clip(2) }, speed: 1, loop: true, position: [290, 150] },
        ],
        transitions: [
          { from: '*', to: 'airborne', conditions: [{ parameter: 'grounded', op: 'false' }], duration: fade },
          { from: 'airborne', to: 'run', conditions: [{ parameter: 'grounded', op: 'true' }, { parameter: 'speed', op: 'greater', value: LEGACY_RUN_SPEED_EPS }], duration: fade },
          { from: 'airborne', to: 'idle', conditions: [{ parameter: 'grounded', op: 'true' }], duration: fade },
          { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: LEGACY_RUN_SPEED_EPS }], duration: fade },
          { from: 'run', to: 'idle', conditions: [{ parameter: 'speed', op: 'less', value: LEGACY_RUN_SPEED_EPS }], duration: fade },
        ],
        entry: 'idle',
        events: [],
      };
      controllers.push(controller);
      notes.push(`made the animator "${controller.name}" (${id}) from the old idle/run/airborne animation`);
    }
    delete e.components['modelAnimation'];
    e.components['animator'] = { controller: id };
    migrated += 1;
  });
  if (migrated === 0) return { scenes: [...scenes], content, migrated: 0, notes };
  next.content.animators = controllers.sort((a, b) => (a.controllerId < b.controllerId ? -1 : a.controllerId > b.controllerId ? 1 : 0));
  notes.push(`${migrated} object(s) now play their idle/run/airborne animation with an animator`);
  return { scenes: next.scenes, content: next.content, migrated, notes };
}

/**
 * The length of each animation of a GLB (seconds, in file order): the latest
 * key time over its samplers' inputs (the accessor `max`, which glTF requires
 * for animation inputs, else the last float of the accessor). Null when the
 * bytes are not a readable GLB.
 */
export function glbClipDurations(bytes: Uint8Array): { name: string; duration: number }[] | null {
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return null;
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.byteLength) return null;
  let json: {
    animations?: { name?: string; samplers?: { input?: number }[] }[];
    accessors?: { bufferView?: number; byteOffset?: number; count?: number; max?: number[]; componentType?: number }[];
    bufferViews?: { byteOffset?: number; byteLength?: number; byteStride?: number }[];
  };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as typeof json;
  } catch {
    return null;
  }
  const binStart = 20 + jsonLength + 8;
  const hasBin = binStart <= bytes.byteLength && view.getUint32(20 + jsonLength + 4, true) === 0x004e4942;
  const lastKey = (accessorIndex: number | undefined): number => {
    const acc = accessorIndex === undefined ? undefined : json.accessors?.[accessorIndex];
    if (acc === undefined) return 0;
    const max = acc.max?.[0];
    if (typeof max === 'number' && Number.isFinite(max)) return max;
    const bv = acc.bufferView === undefined ? undefined : json.bufferViews?.[acc.bufferView];
    if (!hasBin || bv === undefined || acc.componentType !== 5126 || !(Number(acc.count) > 0)) return 0;
    const at = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + ((acc.count as number) - 1) * (bv.byteStride ?? 4);
    return at + 4 <= bytes.byteLength ? view.getFloat32(at, true) : 0;
  };
  return (json.animations ?? []).map((a, i) => ({
    name: typeof a.name === 'string' ? a.name : `animation_${i}`,
    duration: Math.max(0, ...(a.samplers ?? []).map((s) => lastKey(s.input))),
  }));
}
