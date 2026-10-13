/**
 * A kit checked against the trim sheet spec (project-model `kit-checks`):
 * every piece in its slots from the piece's file, and its trim sheet's row
 * table — with the sheet's albedo pixels when asked (`image`: gutters,
 * seams, height in A; decoded on the texture encoder's worker).
 *
 * The kit editor shows the report (`GET …/kits/:kitId/check`); the kit
 * Problems add each piece's errors from the same facts.
 *
 * The kit Problems run after every change that can matter — a material's
 * slider among them — so they re-check only the kits whose inputs changed:
 * the kit item, its trim sheet, the cell of the layer that uses it, its
 * pieces' files and material maps (one digest per kit). A piece's facts are
 * kept per model and piece, under the file's digest, for as long as a kit
 * names that piece: a project's kits bound the cache, not a count. A sheet's
 * pixel checks are kept per trim material, under its albedo's version and
 * row table.
 */
import { createHash } from 'node:crypto';

import { kitPieceChecks, pieceFacts, trimSpecChecks, type KitCheckReport, type KitPieceReport, type KitSheetReport, type PieceFacts, type SheetCheckReport } from '@thirdlight/project-model/kit-checks';
import type { KitDef } from '@thirdlight/project-model/kits';
import type { MaterialDef } from '@thirdlight/project-model';
import { BLOCK_LAYER_DEFAULT } from '@thirdlight/project-model/limits';
import { resolveMaterial } from '@thirdlight/project-model/material-reads';
import type { TrimSheet } from '@thirdlight/project-model/trim-sheet';
import type { WorkspaceService } from '@thirdlight/workspace';

import type { TextureEncoder } from './texture-encode';
import { readTrimSheetImage, textureVersionOf, TRIM_CHECK_TOLERANCE, TRIM_CHECK_TOLERANCE_TRANSCODED } from './trim-check';

type CapturedAsset = { assetId: string; kind?: string; currentVersion: number; versions: { version: number; sourceDigest: string }[]; materials?: Record<string, string> };

interface CapturedContent {
  kits?: KitDef[];
  materials?: MaterialDef[];
  assets?: CapturedAsset[];
}

type CapturedScene = { entities?: { components?: Record<string, unknown> }[] };

/** What one read of the project gives every kit's check. */
interface ProjectView {
  content: CapturedContent;
  assets: ReadonlyMap<string, CapturedAsset>;
  /** Per kit: the cell width of the block layer that uses it (absent: no layer does). */
  cells: ReadonlyMap<string, number>;
}

/** One project's kept results. */
interface ProjectCache {
  /** `assetId|piece` → the facts of the file with `digest`. */
  facts: Map<string, { digest: string; facts: PieceFacts }>;
  /** Trim material → its sheet's pixel checks for `key` (albedo version and row table). */
  sheets: Map<string, { key: string; report: SheetCheckReport }>;
  /** Kit → its piece error lines for the inputs digest `key`. */
  kits: Map<string, { key: string; lines: string[] }>;
}

/** The file identity of an asset's current version (a version without a digest: its asset and version). */
const fileKeyOf = (a: CapturedAsset): string => {
  const digest = a.versions.find((v) => v.version === a.currentVersion)?.sourceDigest ?? '';
  return digest !== '' ? digest : `${a.assetId}@${a.currentVersion}`;
};

export function createKitChecker(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }) {
  const projects = new Map<string, ProjectCache>();
  const cacheOf = (projectId: string): ProjectCache => {
    let c = projects.get(projectId);
    if (c === undefined) projects.set(projectId, (c = { facts: new Map(), sheets: new Map(), kits: new Map() }));
    return c;
  };

  const viewOf = (projectId: string): ProjectView | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const content = captured.read.content as unknown as CapturedContent;
    const cells = new Map<string, number>();
    const scenes = ((captured.read as { scenes?: CapturedScene[] }).scenes ?? [captured.read.scene as unknown as CapturedScene]);
    for (const sc of scenes) {
      for (const e of sc.entities ?? []) {
        const layer = e.components?.['blockLayer'] as { kitId?: unknown; cellSize?: unknown } | undefined;
        if (layer === undefined || typeof layer.kitId !== 'string' || cells.has(layer.kitId)) continue;
        const size = Array.isArray(layer.cellSize) ? (layer.cellSize as number[]) : BLOCK_LAYER_DEFAULT.cellSize;
        cells.set(layer.kitId, size[0] ?? BLOCK_LAYER_DEFAULT.cellSize[0]);
      }
    }
    return { content, assets: new Map((content.assets ?? []).map((a) => [a.assetId, a])), cells };
  };

  /** A piece's facts from the model's current file (null: no such model, or its bytes cannot be read). */
  const factsOf = (projectId: string, view: ProjectView, assetId: string, piece: string | undefined): PieceFacts | null => {
    const a = view.assets.get(assetId);
    if (a === undefined || (a.kind ?? 'model') !== 'model') return null;
    const cache = cacheOf(projectId).facts;
    const key = `${assetId}|${piece ?? ''}`;
    const digest = fileKeyOf(a);
    const hit = cache.get(key);
    if (hit !== undefined && hit.digest === digest) return hit.facts;
    const read = deps.service.readBlob(projectId, { assetId, version: a.currentVersion });
    if (!read.ok) return null;
    const facts = pieceFacts(read.bytes, piece);
    cache.set(key, { digest, facts });
    return facts;
  };

  const sheetOf = (content: CapturedContent, kit: KitDef): { def: MaterialDef; trim: TrimSheet } | null => {
    if (kit.trimMaterial === undefined) return null;
    const m = resolveMaterial(content.materials ?? [], kit.trimMaterial);
    return m !== null && m.shader === 'trim' && m.trim !== undefined ? { def: m, trim: m.trim } : null;
  };

  /** The digest of everything a kit's piece checks read: a kit whose digest is unchanged answers what it answered. */
  const kitInputsKey = (view: ProjectView, kit: KitDef, sheet: { trim: TrimSheet } | null): string => {
    const h = createHash('sha256');
    h.update(JSON.stringify(kit));
    h.update(`\0${sheet === null ? '' : JSON.stringify(sheet.trim)}\0${view.cells.get(kit.kitId) ?? ''}`);
    for (const list of Object.values(kit.pieces ?? {})) {
      for (const p of list) {
        const a = view.assets.get(p.assetId);
        h.update(`\0${p.assetId}|${a === undefined ? '-' : `${a.kind ?? 'model'}|${fileKeyOf(a)}|${JSON.stringify(a.materials ?? null)}`}`);
      }
    }
    return h.digest('hex');
  };

  const contextOf = (view: ProjectView, kit: KitDef, slot: string, sheet: { trim: TrimSheet } | null, assetId: string) => {
    const materials = view.assets.get(assetId)?.materials;
    const cell = view.cells.get(kit.kitId);
    return { slot, ...(sheet !== null ? { sheet: { materialId: kit.trimMaterial!, trim: sheet.trim } } : {}), ...(materials !== undefined ? { materials } : {}), ...(cell !== undefined ? { cell } : {}) };
  };

  /** One kit's pieces checked (and its sheet's table; its pixels too with `image`). */
  const check = async (projectId: string, kitId: string, options: { image: boolean }): Promise<KitCheckReport | { ok: false; code: string; message: string }> => {
    const view = viewOf(projectId);
    if (view === null) return { ok: false, code: 'project_not_found', message: `no project "${projectId}"` };
    const { content } = view;
    const kit = content.kits?.find((k) => k.kitId === kitId);
    if (kit === undefined) return { ok: false, code: 'reference_missing', message: `no kit "${kitId}" in this project` };
    const sheet = sheetOf(content, kit);
    const pieces: KitPieceReport[] = [];
    for (const [slot, list] of Object.entries(kit.pieces ?? {})) {
      list.forEach((p, index) => {
        const f = factsOf(projectId, view, p.assetId, p.piece);
        const base = { slot, index, assetId: p.assetId, ...(p.piece !== undefined ? { piece: p.piece } : {}), ...(p.weight !== undefined ? { weight: p.weight } : {}) };
        if (f === null) {
          pieces.push({ ...base, present: false, pieces: [], triangles: [], lods: [], collider: false, checks: [{ id: 'file', state: 'err', title: 'The model is not in the project', detail: `“${p.assetId}” is missing or not a model: pick another piece for the slot.` }] });
          return;
        }
        const ctx = contextOf(view, kit, slot, sheet, p.assetId);
        const checks = kitPieceChecks(f, ctx);
        const b = f.bounds;
        const size = b === null ? undefined : ([0, 1, 2].map((i) => Math.round((b.max[i]! - b.min[i]!) * 1000) / 1000) as [number, number, number]);
        pieces.push({ ...base, present: true, pieces: f.pieces, triangles: f.triangles, lods: f.lods, collider: f.collider, ...(size !== undefined ? { size } : {}), ...(ctx.materials !== undefined ? { materials: ctx.materials } : {}), checks });
      });
    }
    let sheetReport: KitSheetReport | null = null;
    if (sheet !== null) {
      const materialId = kit.trimMaterial!;
      const albedo = sheet.def.textures['map'] ?? null;
      let report = trimSpecChecks(sheet.trim);
      let imageRead = false;
      let imageError: string | undefined;
      // Pixels checked before for this image and table are reused (no decode) even when not asked.
      const v = albedo !== null ? textureVersionOf(deps.service, projectId, albedo) : null;
      const key = v === null ? '' : `${albedo}@${v.version}|${v.digest}|${JSON.stringify(sheet.trim)}`;
      const sheets = cacheOf(projectId).sheets;
      const hit = key !== '' ? sheets.get(materialId) : undefined;
      if (hit !== undefined && hit.key === key) {
        report = hit.report;
        imageRead = true;
      } else if (options.image && albedo !== null) {
        const img = await readTrimSheetImage(deps, projectId, albedo);
        if (img.ok) {
          report = trimSpecChecks(sheet.trim, { rgba: img.rgba, width: img.width, height: img.height, tolerance: img.transcoded ? TRIM_CHECK_TOLERANCE_TRANSCODED : TRIM_CHECK_TOLERANCE });
          if (key !== '') sheets.set(materialId, { key, report });
          imageRead = true;
        } else imageError = img.message;
      }
      sheetReport = { materialId, name: sheet.def.name ?? materialId, albedo, trim: sheet.trim, report, imageRead, ...(imageError !== undefined ? { imageError } : {}) };
    }
    return { ok: true, kitId, sheet: sheetReport, pieces };
  };

  /**
   * Each kit's piece errors in plain words, from the same checks (what the
   * kit Problems add to its missing references). Only kits whose inputs
   * changed are checked again; reads piece files the cache does not hold;
   * never the sheet's pixels. What no kit names any more is let go.
   */
  const pieceErrors = (projectId: string): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    const view = viewOf(projectId);
    if (view === null) return out;
    const cache = cacheOf(projectId);
    const kits = new Map<string, { key: string; lines: string[] }>();
    const named = new Set<string>();
    const sheetsNamed = new Set<string>();
    for (const kit of view.content.kits ?? []) {
      const sheet = sheetOf(view.content, kit);
      if (kit.trimMaterial !== undefined) sheetsNamed.add(kit.trimMaterial);
      for (const list of Object.values(kit.pieces ?? {})) for (const p of list) named.add(`${p.assetId}|${p.piece ?? ''}`);
      const key = kitInputsKey(view, kit, sheet);
      const before = cache.kits.get(kit.kitId);
      let lines: string[];
      if (before !== undefined && before.key === key) lines = before.lines;
      else {
        lines = [];
        for (const [slot, list] of Object.entries(kit.pieces ?? {})) {
          for (const p of list) {
            const f = factsOf(projectId, view, p.assetId, p.piece);
            if (f === null) continue;
            const errs = kitPieceChecks(f, contextOf(view, kit, slot, sheet, p.assetId)).filter((c) => c.state === 'err');
            for (const e of errs) lines.push(`the ${slot} piece "${p.piece ?? p.assetId}": ${e.title.charAt(0).toLowerCase()}${e.title.slice(1)}`);
          }
        }
      }
      kits.set(kit.kitId, { key, lines });
      if (lines.length > 0) out.set(kit.kitId, lines);
    }
    cache.kits = kits;
    for (const k of [...cache.facts.keys()]) if (!named.has(k)) cache.facts.delete(k);
    for (const m of [...cache.sheets.keys()]) if (!sheetsNamed.has(m)) cache.sheets.delete(m);
    return out;
  };

  return { check, pieceErrors };
}

export type KitChecker = ReturnType<typeof createKitChecker>;
