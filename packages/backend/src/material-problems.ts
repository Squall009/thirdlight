/**
 * Graph materials' compile problems on the backend — the same
 * `materialGraphProblems` the editor's Problems tab runs (three-adapter:
 * the graph built to TSL nodes without a renderer), so MCP and tools see a
 * broken material without an editor open.
 *
 * The backend checks a project's materials when it loads the project (the
 * first read: an editor attaching, a problems or materials query) and after
 * every applied change (a material set, a material function edited, a
 * texture published or deleted). Each material's result is cached by what
 * its compile reads (the graph's canonical text with the functions it
 * reaches, and the project's texture ids), so a change recompiles only the
 * materials it touched. A material whose problems appear or change is
 * logged once in the project's problems (`tl_diagnostics`); the current
 * problems are in `tl_diagnostics` (`materialProblems`) and
 * `tl_content_query target="materials"`.
 *
 * A layered material's trim sheets (`layerSheets`) are checked beside its
 * compile: each names a trim material, and all share one row table (its trim
 * layers read one), else the rows that differ are listed.
 */
import { createHash } from 'node:crypto';

import { layerSheetMismatches } from '@thirdlight/project-model/layered-surface';
import { parseFillLayer, textureSlotSetKey, withAssembledSlots, type TextureSlotSet } from '@thirdlight/project-model/texture-slots';
import type { TrimSheet } from '@thirdlight/project-model/trim-sheet';
import { materialGraphCanonical, materialGraphProblems, type MaterialFunctionLike } from '@thirdlight/three-adapter';

/**
 * A slot list compiles as its array (one texture id standing for the
 * assembled array, never an asset id: ':' is not in the id syntax), as the
 * editor's views and Problems tab compile it.
 */
const slotArrayId = (set: TextureSlotSet): string => `slots:${textureSlotSetKey(set)}`;

export interface MaterialProblem {
  readonly nodeId?: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface MaterialRow {
  readonly materialId: string;
  readonly name: string;
  /** A graph material (only graph materials compile, so only they have problems). */
  readonly graph: boolean;
  readonly problems: readonly MaterialProblem[];
}

interface ContentLike {
  readonly materials?: readonly { materialId: string; name?: string; shader?: string; graph?: unknown; parameters?: unknown; trim?: TrimSheet; layerSheets?: readonly string[] }[];
  readonly graphs?: readonly { graphId: string; kind: string; name?: string; graph: unknown }[];
  readonly assets?: readonly { assetId: string; kind: string }[];
}

/** Bounded compile cache (entries: one per distinct material compile input). */
const CACHE_MAX = 4096;
/** Problems kept per material (the first ones; the count says how many). */
const PROBLEMS_PER_MATERIAL = 32;

export interface MaterialProblemChecker {
  /** Every material of `content` with its problems (compiled, or from the cache). */
  check(content: unknown): MaterialRow[];
  /**
   * Check `projectId`'s materials now and report what changed: the materials
   * whose problems are new or different since the project's last check (a
   * first check reports every material with problems — the load).
   */
  update(projectId: string, content: unknown): { rows: MaterialRow[]; changed: MaterialRow[] };
  /** The last check of a project (null: not checked yet). */
  last(projectId: string): MaterialRow[] | null;
  forget(projectId: string): void;
}

export function createMaterialProblemChecker(): MaterialProblemChecker {
  const cache = new Map<string, readonly MaterialProblem[]>();
  const lastRows = new Map<string, MaterialRow[]>();
  const signatures = new Map<string, Map<string, string>>();

  const check = (raw: unknown): MaterialRow[] => {
    const content = (raw ?? {}) as ContentLike;
    const functions = (content.graphs ?? []).filter((g) => g.kind === 'material-function') as unknown as MaterialFunctionLike[];
    const byId = new Map(functions.map((f) => [f.graphId, f]));
    const textures = [...new Set((content.assets ?? []).filter((a) => a.kind === 'texture').map((a) => a.assetId))].sort();
    const textureSet = new Set(textures);
    const texturesKey = textures.join('\u0000');
    const rows: MaterialRow[] = [];
    for (const m of content.materials ?? []) {
      if (m.graph === undefined || m.graph === null) {
        rows.push({ materialId: m.materialId, name: m.name ?? m.materialId, graph: false, problems: [] });
        continue;
      }
      // Per-layer slots: the array's id, there when every slot names a texture of the project (or is a constant layer).
      const sets: TextureSlotSet[] = [];
      const [drawn] = withAssembledSlots([m as Parameters<typeof withAssembledSlots>[0][number]], (set) => {
        sets.push(set);
        return slotArrayId(set);
      });
      const parameters = drawn!.parameters ?? m.parameters;
      const textureIds = sets.length === 0 ? textureSet : new Set([...textureSet, ...sets.filter((set) => set.layers.every((id) => textureSet.has(id) || parseFillLayer(id) !== null)).map(slotArrayId)]);
      const def = { graph: drawn!.graph ?? m.graph, ...(parameters !== undefined ? { parameters } : {}) } as Parameters<typeof materialGraphProblems>[0];
      let problems: readonly MaterialProblem[];
      try {
        const key = createHash('sha256').update(materialGraphCanonical(def, (id) => byId.get(id) ?? null)).update('\u0001').update(texturesKey).digest('hex');
        const hit = cache.get(key);
        if (hit !== undefined) problems = hit;
        else {
          problems = materialGraphProblems(def, functions, textureIds).map((p) => ({ ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}), severity: p.severity, message: p.message }));
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
          cache.set(key, problems);
        }
      } catch (e) {
        // A graph the compiler cannot even build is a problem of its own (never a backend failure).
        problems = [{ severity: 'error', message: `the graph could not be compiled: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }];
      }
      const sheets = sheetProblems(m, content.materials ?? []);
      rows.push({ materialId: m.materialId, name: m.name ?? m.materialId, graph: true, problems: [...sheets, ...problems].slice(0, PROBLEMS_PER_MATERIAL) });
    }
    return rows;
  };

  return {
    check,
    update(projectId, content) {
      const rows = check(content);
      const before = signatures.get(projectId);
      const now = new Map<string, string>();
      const changed: MaterialRow[] = [];
      for (const r of rows) {
        const sig = JSON.stringify(r.problems);
        now.set(r.materialId, sig);
        if (r.problems.length > 0 && before?.get(r.materialId) !== sig) changed.push(r);
      }
      signatures.set(projectId, now);
      lastRows.set(projectId, rows);
      return { rows, changed };
    },
    last: (projectId) => lastRows.get(projectId) ?? null,
    forget(projectId) {
      signatures.delete(projectId);
      lastRows.delete(projectId);
    },
  };
}

/** A layered material's trim sheets that name no trim material, or whose rows differ from its first sheet's. */
function sheetProblems(m: { readonly layerSheets?: readonly string[] }, materials: NonNullable<ContentLike['materials']>): MaterialProblem[] {
  if (m.layerSheets === undefined) return [];
  const out: MaterialProblem[] = [];
  const sheetOf = (id: string): TrimSheet | null => {
    const s = materials.find((x) => x.materialId === id);
    return s?.shader === 'trim' && s.trim !== undefined ? s.trim : null;
  };
  m.layerSheets.forEach((id, layer) => {
    if (id !== '' && sheetOf(id) === null) out.push({ severity: 'error', message: `layer ${layer + 1}'s trim sheet "${id}" is not a trim material: its mesh-UV layer reads the whole mip chain, and generated walls fall back to the starter rows` });
  });
  const first = m.layerSheets.findIndex((id) => id !== '' && sheetOf(id) !== null);
  for (const x of layerSheetMismatches(m, sheetOf)) {
    out.push({ severity: 'error', message: `layer ${x.layer + 1}'s trim sheet "${x.sheet}" has other rows than layer ${first + 1}'s "${m.layerSheets[first]}" (one row table is read for every trim layer): ${x.differ.join(', ')} differ` });
  }
  return out;
}

/** One line for the problems log. */
export function materialProblemLine(r: MaterialRow): string {
  const errors = r.problems.filter((p) => p.severity === 'error').length;
  const warnings = r.problems.length - errors;
  const counts = [errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : ''].filter((x) => x !== '').join(', ');
  const first = r.problems[0]!;
  return `Material "${r.name}" (${r.materialId}): ${counts} in its graph — ${first.nodeId !== undefined ? `node ${first.nodeId}: ` : ''}${first.message}`;
}
