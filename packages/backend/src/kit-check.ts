/**
 * A kit checked against the trim sheet spec (project-model `kit-checks`):
 * every piece in its slots from the piece's file, and its trim sheet's row
 * table — with the sheet's albedo pixels when asked (`image`: gutters,
 * seams, height in A; decoded on the texture encoder's worker).
 *
 * The kit editor shows the report (`GET …/kits/:kitId/check`); the kit
 * Problems add each piece's errors from the same facts. A piece's facts are
 * kept per file digest and piece, a sheet's pixel checks per image digest
 * and row table, so re-checking after an edit reads only what changed.
 */
import { kitPieceChecks, pieceFacts, trimSpecChecks, type KitCheckReport, type KitPieceReport, type KitSheetReport, type PieceFacts, type SheetCheckReport } from '@thirdlight/project-model/kit-checks';
import type { KitDef } from '@thirdlight/project-model/kits';
import type { MaterialDef } from '@thirdlight/project-model';
import { resolveMaterial } from '@thirdlight/project-model/material-reads';
import type { TrimSheet } from '@thirdlight/project-model/trim-sheet';
import type { WorkspaceService } from '@thirdlight/workspace';

import type { TextureEncoder } from './texture-encode';
import { readTrimSheetImage, textureVersionOf, TRIM_CHECK_TOLERANCE, TRIM_CHECK_TOLERANCE_TRANSCODED } from './trim-check';

/** Facts of this many piece files, and pixel checks of this many sheets, are kept. */
const FACTS_KEPT = 128;
const SHEETS_KEPT = 8;

interface CapturedContent {
  kits?: KitDef[];
  materials?: MaterialDef[];
  assets?: { assetId: string; kind?: string; currentVersion: number; versions: { version: number; sourceDigest: string }[]; materials?: Record<string, string> }[];
}

const keep = <V>(m: Map<string, V>, key: string, value: V, max: number): V => {
  m.delete(key);
  m.set(key, value);
  while (m.size > max) m.delete(m.keys().next().value!);
  return value;
};

export function createKitChecker(deps: { service: WorkspaceService; encoder: TextureEncoder | undefined }) {
  const facts = new Map<string, PieceFacts>();
  const sheets = new Map<string, SheetCheckReport>();

  const contentOf = (projectId: string): CapturedContent | null => {
    const captured = deps.service.readCapturedV3(projectId);
    return captured.ok ? (captured.read.content as unknown as CapturedContent) : null;
  };

  /** A piece's facts from the model's current file (null: no such model, or its bytes cannot be read). */
  const factsOf = (projectId: string, content: CapturedContent, assetId: string, piece: string | undefined): PieceFacts | null => {
    const a = content.assets?.find((x) => x.assetId === assetId);
    if (a === undefined || (a.kind ?? 'model') !== 'model') return null;
    const digest = a.versions.find((v) => v.version === a.currentVersion)?.sourceDigest ?? '';
    const key = `${digest}|${piece ?? ''}`;
    const hit = facts.get(key);
    if (hit !== undefined && digest !== '') return keep(facts, key, hit, FACTS_KEPT);
    const read = deps.service.readBlob(projectId, { assetId, version: a.currentVersion });
    if (!read.ok) return null;
    return keep(facts, key, pieceFacts(read.bytes, piece), FACTS_KEPT);
  };

  const sheetOf = (content: CapturedContent, kit: KitDef): { def: MaterialDef; trim: TrimSheet } | null => {
    if (kit.trimMaterial === undefined) return null;
    const m = resolveMaterial(content.materials ?? [], kit.trimMaterial);
    return m !== null && m.shader === 'trim' && m.trim !== undefined ? { def: m, trim: m.trim } : null;
  };

  /** One kit's pieces checked (and its sheet's table; its pixels too with `image`). */
  const check = async (projectId: string, kitId: string, options: { image: boolean }): Promise<KitCheckReport | { ok: false; code: string; message: string }> => {
    const content = contentOf(projectId);
    if (content === null) return { ok: false, code: 'project_not_found', message: `no project "${projectId}"` };
    const kit = content.kits?.find((k) => k.kitId === kitId);
    if (kit === undefined) return { ok: false, code: 'reference_missing', message: `no kit "${kitId}" in this project` };
    const sheet = sheetOf(content, kit);
    const pieces: KitPieceReport[] = [];
    for (const [slot, list] of Object.entries(kit.pieces ?? {})) {
      list.forEach((p, index) => {
        const f = factsOf(projectId, content, p.assetId, p.piece);
        const base = { slot, index, assetId: p.assetId, ...(p.piece !== undefined ? { piece: p.piece } : {}), ...(p.weight !== undefined ? { weight: p.weight } : {}) };
        if (f === null) {
          pieces.push({ ...base, present: false, pieces: [], triangles: [], lods: [], collider: false, checks: [{ id: 'file', state: 'err', title: 'The model is not in the project', detail: `“${p.assetId}” is missing or not a model: pick another piece for the slot.` }] });
          return;
        }
        const materials = content.assets?.find((a) => a.assetId === p.assetId)?.materials;
        const checks = kitPieceChecks(f, { slot, ...(sheet !== null ? { sheet: { materialId: kit.trimMaterial!, trim: sheet.trim } } : {}), ...(materials !== undefined ? { materials } : {}) });
        const b = f.bounds;
        const size = b === null ? undefined : ([0, 1, 2].map((i) => Math.round((b.max[i]! - b.min[i]!) * 1000) / 1000) as [number, number, number]);
        pieces.push({ ...base, present: true, pieces: f.pieces, triangles: f.triangles, lods: f.lods, collider: f.collider, ...(size !== undefined ? { size } : {}), ...(materials !== undefined ? { materials } : {}), checks });
      });
    }
    let sheetReport: KitSheetReport | null = null;
    if (sheet !== null) {
      const albedo = sheet.def.textures['map'] ?? null;
      let report = trimSpecChecks(sheet.trim);
      let imageRead = false;
      let imageError: string | undefined;
      // Pixels checked before for this image and table are reused (no decode) even when not asked.
      const v = albedo !== null ? textureVersionOf(deps.service, projectId, albedo) : null;
      const key = v === null ? '' : `${v.digest}|${JSON.stringify(sheet.trim)}`;
      const hit = key !== '' ? sheets.get(key) : undefined;
      if (hit !== undefined) {
        report = keep(sheets, key, hit, SHEETS_KEPT);
        imageRead = true;
      } else if (options.image && albedo !== null) {
        const img = await readTrimSheetImage(deps, projectId, albedo);
        if (img.ok) {
          report = trimSpecChecks(sheet.trim, { rgba: img.rgba, width: img.width, height: img.height, tolerance: img.transcoded ? TRIM_CHECK_TOLERANCE_TRANSCODED : TRIM_CHECK_TOLERANCE });
          if (key !== '') keep(sheets, key, report, SHEETS_KEPT);
          imageRead = true;
        } else imageError = img.message;
      }
      sheetReport = { materialId: kit.trimMaterial!, name: sheet.def.name ?? kit.trimMaterial!, albedo, trim: sheet.trim, report, imageRead, ...(imageError !== undefined ? { imageError } : {}) };
    }
    return { ok: true, kitId, sheet: sheetReport, pieces };
  };

  /**
   * Each kit's piece errors in plain words, from the same checks (what the
   * kit Problems add to its missing references). Reads piece files the
   * cache does not hold; never the sheet's pixels.
   */
  const pieceErrors = (projectId: string): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    const content = contentOf(projectId);
    if (content === null) return out;
    for (const kit of content.kits ?? []) {
      const sheet = sheetOf(content, kit);
      const lines: string[] = [];
      for (const [slot, list] of Object.entries(kit.pieces ?? {})) {
        for (const p of list) {
          const f = factsOf(projectId, content, p.assetId, p.piece);
          if (f === null) continue;
          const materials = content.assets?.find((a) => a.assetId === p.assetId)?.materials;
          const errs = kitPieceChecks(f, { slot, ...(sheet !== null ? { sheet: { materialId: kit.trimMaterial!, trim: sheet.trim } } : {}), ...(materials !== undefined ? { materials } : {}) }).filter((c) => c.state === 'err');
          for (const e of errs) lines.push(`the ${slot} piece "${p.piece ?? p.assetId}": ${e.title.charAt(0).toLowerCase()}${e.title.slice(1)}`);
        }
      }
      if (lines.length > 0) out.set(kit.kitId, lines);
    }
    return out;
  };

  return { check, pieceErrors };
}

export type KitChecker = ReturnType<typeof createKitChecker>;
