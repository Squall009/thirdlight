/**
 * Component fields that name another object (a camera's target, the path a
 * rail rides, a socket's model). Inside a prefab such a value may name a part
 * of the prefab by its local id; every copy (placed, spawned, a live block's
 * object) then names its own part, as a script's object property does. A
 * value naming anything else (an object of the scene) is kept as written.
 *
 * Paths are relative to an object's components. The descriptors' entity
 * fields are the source; a test keeps this list equal to them.
 */
export const COMPONENT_ENTITY_REFS: readonly string[] = Object.freeze([
  'virtualCamera/target',
  'virtualCamera/path',
  'cameraRegion/camera',
  'socketAttach/target',
  'animator/lookAt/target',
  'trigger/sceneTransition/spawn',
  'blockFootprint/layer',
]);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value at a `/`-joined path under `root` (undefined when it is not there). */
export function valueAtPath(root: Record<string, unknown>, path: string): unknown {
  let at: unknown = root;
  for (const seg of path.split('/')) {
    if (!isRecord(at)) return undefined;
    at = at[seg];
  }
  return at;
}

/** Set the value at a path whose parent exists (a no-op otherwise). */
export function setValueAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('/');
  let at: unknown = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isRecord(at)) return;
    at = at[seg];
  }
  if (isRecord(at)) at[segs[segs.length - 1] as string] = value;
}

/** The component reference paths whose value names an object `names` knows. */
export function componentRefsNaming(components: Record<string, unknown>, names: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const path of COMPONENT_ENTITY_REFS) {
    const v = valueAtPath(components, path);
    if (typeof v === 'string' && names(v)) out.push(path);
  }
  return out;
}

/** Map every component reference `map` knows (in place); the others stay. */
export function mapComponentRefs(components: Record<string, unknown>, map: (id: string) => string | undefined): void {
  for (const path of COMPONENT_ENTITY_REFS) {
    const v = valueAtPath(components, path);
    if (typeof v !== 'string') continue;
    const to = map(v);
    if (to !== undefined) setValueAtPath(components, path, to);
  }
}

/**
 * An override's value with the component references in it mapped (`path`
 * relative to the components: a whole component, an object in it, or the
 * reference itself). Values that hold no reference come back unchanged.
 */
export function mapRefsInValue(path: string, value: unknown, map: (id: string) => string | undefined): unknown {
  let out = value;
  for (const ref of COMPONENT_ENTITY_REFS) {
    if (ref === path) {
      const to = typeof value === 'string' ? map(value) : undefined;
      return to ?? value;
    }
    if (!ref.startsWith(`${path}/`) || !isRecord(out)) continue;
    const rest = ref.slice(path.length + 1);
    const v = valueAtPath(out, rest);
    const to = typeof v === 'string' ? map(v) : undefined;
    if (to === undefined) continue;
    if (out === value) out = structuredClone(value);
    setValueAtPath(out as Record<string, unknown>, rest, to);
  }
  return out;
}
