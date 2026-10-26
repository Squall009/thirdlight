/**
 * Imported models' distance-field bricks as an import product: made from
 * the model file when it is imported (the backend asks after each import),
 * kept in the project's import cache keyed by the file's digest like the
 * other import results, and shipped beside the models a build places
 * static (the lighting tracer's shape of them). A build whose cache lacks
 * them (an import before bricks existed, a cleared cache) makes them then.
 */
import { buildDistanceBricks, encodeDistanceBricks, readModelGeometry, DISTANCE_BRICKS_VERSION, expandArchitecture, architectureCopies, type ArchitectureComponent, type ArchitectureStyles, type PrefabDefinition } from '@thirdlight/project-model';
import type { BlobFile, ImportKey, WorkspaceService } from '@thirdlight/workspace';

/** The import cache's importer name of a model's bricks. */
export const MODEL_BRICKS_IMPORTER = 'distance-bricks';

/** The import cache key of the bricks of the model file `sourceDigest`. */
export function modelBricksKey(sourceDigest: string): ImportKey {
  return { sourceDigest, importer: MODEL_BRICKS_IMPORTER, importerVersion: String(DISTANCE_BRICKS_VERSION), settings: {} };
}

/** The bricks blob of a model file (null: it has no render triangles to make a field of). */
export function modelBricksBlob(glb: Uint8Array): { ok: true; bytes: Uint8Array | null } | { ok: false; message: string } {
  const g = readModelGeometry(glb, { uv1: true });
  if (!g.ok) return { ok: false, message: g.message };
  const b = buildDistanceBricks(g.geometry);
  return { ok: true, bytes: b.sets.length > 0 ? encodeDistanceBricks(b) : null };
}

/**
 * The cached bricks file of model file `sourceDigest`, made and stored first
 * when the cache does not hold it (`read` gives the model's bytes then).
 * Null file: the model has nothing to make a field of.
 */
export function ensureModelBricks(service: WorkspaceService, projectId: string, sourceDigest: string, read: () => Uint8Array | null): { ok: true; file: BlobFile | null } | { ok: false; message: string } {
  const key = modelBricksKey(sourceDigest);
  const cached = service.locateImportedArtifact(projectId, key);
  if (cached !== null) return { ok: true, file: cached };
  const glb = read();
  if (glb === null) return { ok: false, message: 'the model file could not be read' };
  const made = modelBricksBlob(glb);
  if (!made.ok) return made;
  if (made.bytes === null) return { ok: true, file: null };
  const stored = service.writeImportedArtifact(projectId, key, made.bytes);
  if (!stored.ok) return { ok: false, message: stored.error.message ?? stored.error.code };
  return { ok: true, file: service.locateImportedArtifact(projectId, key) };
}

/**
 * The model assets a build places static: entities marked static with a
 * model (in the scenes and the prefabs), and generated architecture's kit
 * copies (architecture never moves).
 */
export function staticModelUses(scenes: readonly unknown[] | undefined, prefabs: readonly PrefabDefinition[], archStyles: () => ArchitectureStyles): Set<string> {
  const out = new Set<string>();
  const visit = (entities: unknown): void => {
    if (!Array.isArray(entities)) return;
    for (const e of entities) {
      const ent = e as { static?: unknown; components?: Record<string, unknown> } | null;
      const c = ent?.components;
      const model = c?.['model'] as { asset?: { assetId?: unknown } } | undefined;
      if (ent?.static === true && typeof model?.asset?.assetId === 'string') out.add(model.asset.assetId);
      const arch = c?.['architecture'] as ArchitectureComponent | undefined;
      if (arch !== undefined && Array.isArray(arch.elements)) for (const set of architectureCopies(expandArchitecture(arch, [0, 0, 0], archStyles()).component)) out.add(set.model.assetId);
    }
  };
  for (const sc of scenes ?? []) visit((sc as { entities?: unknown }).entities);
  for (const d of prefabs) visit(d.entities);
  return out;
}

/** One model's shipped bricks, as its catalog row names them. */
export interface ModelBricksRow {
  digest: string;
  byteLength: number;
}

/**
 * A build's bricks: one file per model it places static (`uses`), from the
 * import cache (made there first when missing). With `locate` the files
 * are found, not read. A model whose bricks cannot be made is a line in
 * `problems`; it still ships, lit by probes only.
 */
export async function closureModelBricks(a: {
  service: WorkspaceService;
  projectId: string;
  uses: ReadonlySet<string>;
  assets: readonly { assetId: string; kind: string; version: number; sourceDigest: string }[];
  modelBytes: ReadonlyMap<string, Uint8Array>;
  locate: boolean;
  readWhole: (f: BlobFile) => Promise<Uint8Array | string>;
}): Promise<{ rows: Map<string, ModelBricksRow>; files: { path: string; digest: string; byteLength: number; contentType: string; file: BlobFile }[]; artifacts: { path: string; bytes: Uint8Array; digest: string; contentType: string }[]; problems: string[] }> {
  const rows = new Map<string, ModelBricksRow>();
  const files: { path: string; digest: string; byteLength: number; contentType: string; file: BlobFile }[] = [];
  const artifacts: { path: string; bytes: Uint8Array; digest: string; contentType: string }[] = [];
  const problems: string[] = [];
  const shipped = new Set<string>();
  for (const m of [...a.assets].filter((x) => x.kind === 'model' && a.uses.has(x.assetId)).sort((x, y) => (x.assetId < y.assetId ? -1 : x.assetId > y.assetId ? 1 : 0))) {
    const made = ensureModelBricks(a.service, a.projectId, m.sourceDigest, () => {
      const known = a.modelBytes.get(m.assetId);
      if (known !== undefined) return known;
      const r = a.service.readBlob(a.projectId, { assetId: m.assetId, version: m.version });
      return r.ok ? r.bytes : null;
    });
    if (!made.ok) {
      problems.push(`the distance-field bricks of ${m.assetId}: ${made.message}`.slice(0, 256));
      continue;
    }
    if (made.file === null) continue;
    const f = made.file;
    rows.set(m.assetId, { digest: f.digest, byteLength: f.byteLength });
    if (shipped.has(f.digest)) continue;
    shipped.add(f.digest);
    const path = `content/sha256/${f.digest}`;
    if (a.locate) files.push({ path, digest: f.digest, byteLength: f.byteLength, contentType: 'application/octet-stream', file: f });
    else {
      const bytes = await a.readWhole(f);
      if (typeof bytes === 'string') {
        problems.push(`the distance-field bricks of ${m.assetId}: ${bytes}`.slice(0, 256));
        rows.delete(m.assetId);
        continue;
      }
      artifacts.push({ path, bytes, digest: f.digest, contentType: 'application/octet-stream' });
    }
  }
  return { rows, files, artifacts, problems };
}

/**
 * The closure's part: the bricks of what it places static (`closureModelBricks`),
 * named on their model rows (`assets`, by `view`'s order, with `shippedKey`
 * the catalog's key of each; a streamed texture's row is never a model), a
 * problem line per model without them; `asBuffers` then hands the files to
 * the build's buffers (read by digest, like the instance buffers) and gives
 * the manifest's buffer rows they add.
 */
export async function shipModelBricks(a: Omit<Parameters<typeof closureModelBricks>[0], 'assets'> & {
  assets: { assetId: string; bricks?: ModelBricksRow }[];
  view: Parameters<typeof closureModelBricks>[0]['assets'];
  shippedKey: string[];
  streamed: ReadonlyMap<string, unknown>;
  checks: { code: 'model_bricks'; refuse: false; message: string }[] | { code: string; refuse: boolean; message: string }[];
}): Promise<{ asBuffers(buffers: ReadonlyMap<string, number>, files: { path: string; digest: string; byteLength: number; contentType: string; file: BlobFile }[], artifacts: { path: string; bytes: Uint8Array; digest: string; contentType: string }[]): (readonly [string, number])[] }> {
  const made = await closureModelBricks({ ...a, assets: a.view });
  for (let i = 0; i < a.assets.length; i += 1) {
    const row = made.rows.get(a.assets[i]!.assetId);
    if (row === undefined || a.streamed.has(a.assets[i]!.assetId)) continue;
    a.assets[i] = { ...a.assets[i]!, bricks: row };
    a.shippedKey[i] = `${a.shippedKey[i]!}:bricks:${row.digest}`;
  }
  for (const message of made.problems) (a.checks as { code: string; refuse: boolean; message: string }[]).push({ code: 'model_bricks', refuse: false, message });
  return {
    asBuffers(buffers, files, artifacts) {
      const fresh = <T extends { digest: string }>(list: T[]): T[] => list.filter((b) => !buffers.has(b.digest));
      files.push(...fresh(made.files));
      artifacts.push(...fresh(made.artifacts));
      return [...fresh(made.files).map((f) => [f.digest, f.byteLength] as const), ...fresh(made.artifacts).map((f) => [f.digest, f.bytes.length] as const)];
    },
  };
}
