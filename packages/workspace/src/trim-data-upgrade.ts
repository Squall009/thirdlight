/**
 * Trim data left in its old places is moved to where it is kept now, at
 * the open: COLOR_0 and vertex paint always mean layer weights and wetness
 * (base 1 − (R + G + B), R/G/B layers 2–4, A wetness), and a trim sheet is
 * one layer whose only paint is wetness on A.
 *
 * - **Models authored for a trim sheet.** A model mapped to a trim material
 *   whose file carries COLOR_0 there was authored with trim data in it
 *   (R occlusion, B wetness, the spec's convention). Its record is set to
 *   `vertexColors: 'trim'`, so the renderer moves that COLOR_0 into the trim
 *   data attribute as the model loads. The file is the game's and stays as
 *   it is (an art tool keeps writing that convention); a model imported
 *   later is set in its import settings.
 * - **Paint on trim surfaces.** Paint stored with the old trim meaning
 *   (G grime, B wetness) on meshes drawn with a trim material — a model's
 *   meshes, an instance set's copies, generated architecture's paths — has
 *   its wetness moved from B to A (the larger of the two) and its G and B
 *   cleared: grime is gone (dirt is a painted layer), and a trim sheet has
 *   no layers 2–4.
 *
 * It runs once per project, recorded in `project.json` (`upgrades`): after the
 * move, G and B are layers 3–4 again on any surface a later mapping makes
 * layered, so the data cannot say which meaning it has. A project without a
 * trim material holds nothing in the old meaning: its first trim material is
 * made in the current one, and the edit that makes it records the upgrade.
 *
 * Pure apart from the reads and writes it is handed: the documents in, the
 * changed documents out (null: nothing to change).
 */
import { paintMeshKey, resolveMaterial, VERTEX_PAINT_BYTES, type ContentCatalogV4, type InstancePaint, type MaterialDef, type ModelGeometryPrimitive, type ProjectManifestV2, type SceneV4, type VertexPaintComponent } from '@thirdlight/project-model';

/** This upgrade's id in the manifest's `upgrades`. */
export const TRIM_DATA_UPGRADE = 'trim-data';

/** Whether a project's materials can draw anything as a trim sheet (a trim shader, or an instance that may resolve to one). */
export function hasTrimMaterials(content: ContentCatalogV4): boolean {
  return (content.materials ?? []).some((m) => m.shader === 'trim' || m.instanceOf !== undefined);
}

/** The manifest with this upgrade recorded (null: it is already). */
export function withTrimDataRecorded(manifest: ProjectManifestV2): ProjectManifestV2 | null {
  if (manifest.upgrades?.includes(TRIM_DATA_UPGRADE) === true) return null;
  return { ...manifest, upgrades: [...(manifest.upgrades ?? []), TRIM_DATA_UPGRADE].sort() };
}

export interface TrimDataUpgradeIo {
  /** The render primitives of a model version (read with its surfaces), or null when it cannot be read. */
  primitives(assetId: string, version: number): readonly ModelGeometryPrimitive[] | null;
  /** A stored paint blob's bytes, or null. */
  paint(digest: string): Uint8Array | null;
  /** Store a paint blob; its digest, or null when it could not be written. */
  publish(bytes: Uint8Array): string | null;
}

export interface TrimDataUpgrade {
  content: ContentCatalogV4;
  scenes: SceneV4[];
  /** Models set to read their COLOR_0 as trim data. */
  models: string[];
  /** Painted meshes and path grids whose wetness moved from B to A. */
  repainted: number;
  /** Paint that could not be read or written (it keeps its old bytes). */
  unread: number;
}

type Obj = Record<string, unknown>;
type Mapping = Readonly<Record<string, string>>;

/** A trim material as drawn: a `trim` shader without a graph of its own, through its instance chain. */
function trimMaterials(materials: readonly MaterialDef[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of materials) {
    const r = resolveMaterial(materials, m.materialId);
    if (r !== null && r.shader === 'trim' && r.graph === undefined) out.add(m.materialId);
  }
  return out;
}

const mapped = (mapping: Mapping, material: string | null | undefined): string | undefined => (material !== null && material !== undefined ? mapping[material] : undefined) ?? mapping['*'];

/**
 * Paint bytes (4 a vertex) with the old trim meaning moved over: A = max(A, B), G = B = 0. Null when no vertex
 * has anything on G or B (the paint already means what it does now).
 */
export function trimPaintMoved(bytes: Uint8Array): Uint8Array | null {
  let found = false;
  for (let i = 0; i + 3 < bytes.length && !found; i += VERTEX_PAINT_BYTES) found = bytes[i + 1] !== 0 || bytes[i + 2] !== 0;
  if (!found) return null;
  const out = new Uint8Array(bytes);
  for (let i = 0; i + 3 < out.length; i += VERTEX_PAINT_BYTES) {
    out[i + 3] = Math.max(out[i + 3]!, out[i + 2]!);
    out[i + 1] = 0;
    out[i + 2] = 0;
  }
  return out;
}

export function upgradeTrimData(content: ContentCatalogV4, scenes: readonly SceneV4[], io: TrimDataUpgradeIo): TrimDataUpgrade | null {
  const trim = trimMaterials(content.materials ?? []);
  if (trim.size === 0) return null;
  const assets = new Map(content.assets.map((a) => [a.assetId, a]));
  const primitivesOf = new Map<string, readonly ModelGeometryPrimitive[] | null>();
  const primitives = (assetId: string): readonly ModelGeometryPrimitive[] | null => {
    const a = assets.get(assetId);
    if (a === undefined || a.kind !== 'model') return null;
    if (!primitivesOf.has(assetId)) primitivesOf.set(assetId, io.primitives(assetId, a.currentVersion));
    return primitivesOf.get(assetId)!;
  };
  const drawn = (p: ModelGeometryPrimitive): boolean => !p.collision && p.occluder !== true;

  // Models mapped to a trim material where their file carries COLOR_0.
  const models: string[] = [];
  const nextAssets = content.assets.map((a) => {
    if (a.kind !== 'model' || a.vertexColors !== undefined || a.materials === undefined) return a;
    const mapping = a.materials;
    if (!Object.values(mapping).some((id) => trim.has(id))) return a;
    const prims = primitives(a.assetId);
    if (prims === null || !prims.some((p) => drawn(p) && p.colour === true && trim.has(mapped(mapping, p.material) ?? ''))) return a;
    models.push(a.assetId);
    return { ...a, vertexColors: 'trim' as const };
  });

  let repainted = 0;
  let unread = 0;
  /** A blob moved over (its new digest), or the one given. */
  const moved = (digest: string): string => {
    const bytes = io.paint(digest);
    if (bytes === null) {
      unread++;
      return digest;
    }
    const next = trimPaintMoved(bytes);
    if (next === null) return digest;
    const d = io.publish(next);
    if (d === null) {
      unread++;
      return digest;
    }
    repainted++;
    return d;
  };
  /** The meshes of a model drawn with a trim material under this mapping. */
  const trimMeshes = (assetId: string, mapping: Mapping): ReadonlySet<string> | null => {
    const prims = primitives(assetId);
    if (prims === null) return null;
    return new Set(prims.filter((p) => drawn(p) && trim.has(mapped(mapping, p.material) ?? '')).map((p) => paintMeshKey(p.node, p.primitive)));
  };

  const nextScenes = scenes.map((scene) => {
    let changed = false;
    const entities = scene.entities.map((e) => {
      const c = e.components as Obj;
      const own = (c['materials'] as Mapping | undefined) ?? {};
      let next: Obj | null = null;
      const vp = c['vertexPaint'] as VertexPaintComponent | undefined;
      const modelId = (c['model'] as { asset?: { assetId?: string } } | undefined)?.asset?.assetId;
      if (vp !== undefined) {
        let meshes = vp.meshes;
        if (meshes !== undefined && modelId !== undefined) {
          const onTrim = trimMeshes(modelId, { ...(assets.get(modelId)?.materials ?? {}), ...own });
          if (onTrim !== null && onTrim.size > 0) meshes = meshes.map((m) => (onTrim.has(m.mesh) ? { ...m, paint: moved(m.paint) } : m));
        }
        let paths = vp.paths;
        // Generated architecture wears the object's materials (`architecture` or `*`), its preset's trim sheet without one.
        const archMaterial = own['architecture'] ?? own['*'];
        if (paths !== undefined && c['architecture'] !== undefined && (archMaterial === undefined || trim.has(archMaterial))) {
          paths = paths.map((g) => (g.path === 'spline' ? g : { ...g, paint: moved(g.paint) }));
        }
        if (meshes !== vp.meshes && meshes!.some((m, i) => m.paint !== vp.meshes![i]!.paint)) next = { ...c, vertexPaint: { ...vp, meshes } };
        if (paths !== vp.paths && paths!.some((g, i) => g.paint !== vp.paths![i]!.paint)) next = { ...(next ?? c), vertexPaint: { ...((next?.['vertexPaint'] as VertexPaintComponent | undefined) ?? vp), paths } };
      }
      const inst = c['instances'] as { asset?: { assetId?: string }; paint?: InstancePaint } | undefined;
      const instAsset = inst?.asset?.assetId;
      if (inst?.paint !== undefined && instAsset !== undefined) {
        const onTrim = trimMeshes(instAsset, { ...(assets.get(instAsset)?.materials ?? {}), ...own });
        if (onTrim !== null && onTrim.size > 0) {
          const meshes = inst.paint.meshes.map((m) => (onTrim.has(m.mesh) ? { ...m, paint: moved(m.paint) } : m));
          if (meshes.some((m, i) => m.paint !== inst.paint!.meshes[i]!.paint)) next = { ...(next ?? c), instances: { ...inst, paint: { ...inst.paint, meshes } } };
        }
      }
      if (next === null) return e;
      changed = true;
      return { ...e, components: next } as typeof e;
    });
    return changed ? { ...scene, entities } : scene;
  });

  if (models.length === 0 && repainted === 0 && unread === 0) return null;
  return { content: models.length > 0 ? { ...content, assets: nextAssets } : content, scenes: nextScenes, models, repainted, unread };
}
