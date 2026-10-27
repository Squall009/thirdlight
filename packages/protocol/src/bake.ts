/**
 * The hashes that tell whether a scene's bake is stale: its static objects
 * and its baked and mixed lights as they were when it was baked.
 *
 * Pure: values in, values out.
 */

// ---- stale detection ---------------------------------------------------------------

/** The parts of an entity the bake hashes read (a loose scene entity). */
export interface BakeHashEntity {
  id: string;
  parentId?: string | null;
  active?: boolean;
  static?: boolean;
  components: Record<string, unknown>;
}

/** 64-bit FNV-1a as 16 hex digits (two 32-bit lanes with different offsets). */
export function hash16(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (a >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Static objects that take part in a bake: static, active, with a box, a model or a block layer; generated architecture, which never moves, whether marked static or not. */
export function isBakeStatic(e: BakeHashEntity): boolean {
  if (e.active === false) return false;
  if (e.components['architecture'] !== undefined) return true;
  return e.static === true && (e.components['box'] !== undefined || e.components['model'] !== undefined || e.components['blockLayer'] !== undefined);
}

/** Lights a bake uses: mode "baked" (direct + bounce) or "mixed" (bounce only). */
export function bakeLightMode(e: BakeHashEntity): 'baked' | 'mixed' | null {
  const light = e.components['light'] as { mode?: string } | undefined;
  if (light === undefined || e.active === false) return null;
  return light.mode === 'baked' ? 'baked' : light.mode === 'mixed' ? 'mixed' : null;
}

/**
 * The hashes a bake records (and the editor compares): the static objects'
 * placement and shape, and the baked/mixed lights' values and placement.
 */
export function bakeHashes(entities: readonly BakeHashEntity[]): { staticsHash: string; lightsHash: string } {
  const byId = (a: BakeHashEntity, b: BakeHashEntity): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const statics = entities.filter(isBakeStatic).sort(byId).map((e) => ({
    id: e.id,
    parentId: e.parentId ?? null,
    transform: e.components['transform'],
    box: e.components['box'],
    model: e.components['model'],
    materials: e.components['materials'],
    blockLayer: e.components['blockLayer'],
    architecture: e.components['architecture'],
  }));
  const lights = entities.filter((e) => bakeLightMode(e) !== null).sort(byId).map((e) => ({
    id: e.id,
    parentId: e.parentId ?? null,
    transform: e.components['transform'],
    light: e.components['light'],
  }));
  return { staticsHash: hash16(stable(statics)), lightsHash: hash16(stable(lights)) };
}
