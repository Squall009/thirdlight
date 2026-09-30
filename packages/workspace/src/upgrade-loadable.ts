/**
 * The open's upgrade to explicit loadability.
 *
 * A build ships what scenes reference and what is loadable (an address or a
 * label); an asset a script names only by its id in a string literal is a
 * Problem, not shipped on its own. So that a project made before this keeps
 * what its scripts name, its assets that a script names and that have
 * neither an address nor a label get the label `script-named` once, and the
 * upgrade report lists them. Which assets count as "made before": those read
 * from sidecars written before the record held the address, or every asset
 * of a project whose assets or resources the open is still moving into files.
 * Their sidecars are then written again in this build's format, so the
 * upgrade does not run twice.
 */
import { join } from 'node:path';

import { canonicalLabels, isLoadable, type ContentCatalogV4 } from '@thirdlight/project-model';

import { scriptNamedAssets } from './script-names';
import { writeAtomic, type WriteOps } from './write';
import { UPGRADE_REPORT_FILE } from './upgrade-assets';

/** The label the upgrade gives an asset a script names by its id. */
export const SCRIPT_NAMED_LABEL = 'script-named';

type AssetLike = { assetId: string; address?: string; labels?: string[] };

export interface LoadabilityUpgrade {
  content: ContentCatalogV4;
  /** Assets that got the label, with the scripts that name them. */
  labeled: { assetId: string; scripts: string[] }[];
  /** Assets whose address moved from beside the record into it. */
  addressed: string[];
  /** Whether any record changed (a rewrite of old sidecars alone changes none). */
  changed: boolean;
}

/**
 * The upgraded content (pure but for the source reads): `legacy` names the
 * assets it applies to ('all': every asset), `preAddress` the addresses old
 * sidecars kept beside their record.
 */
export function upgradeLoadability(content: ContentCatalogV4, legacy: ReadonlySet<string> | 'all', preAddress: ReadonlyMap<string, string | null>, read: (digest: string) => Uint8Array | null): LoadabilityUpgrade | null {
  const assets = content.assets as unknown as AssetLike[];
  const applies = (id: string): boolean => legacy === 'all' || legacy.has(id);
  if (!assets.some((a) => applies(a.assetId))) return null;
  const named = new Map(scriptNamedAssets(read, content).filter((n) => applies(n.assetId)).map((n) => [n.assetId, n.scripts]));
  const labeled: { assetId: string; scripts: string[] }[] = [];
  const addressed: string[] = [];
  const next = assets.map((a) => {
    if (!applies(a.assetId)) return a;
    let out: AssetLike = { ...a };
    const address = preAddress.get(a.assetId);
    if (typeof address === 'string' && out.address === undefined) {
      out = { ...out, address };
      addressed.push(a.assetId);
    }
    const scripts = named.get(a.assetId);
    if (scripts !== undefined && !isLoadable(out)) {
      out = { ...out, labels: canonicalLabels([...(out.labels ?? []), SCRIPT_NAMED_LABEL]) };
      labeled.push({ assetId: a.assetId, scripts });
    }
    return out;
  });
  return { content: { ...content, assets: next as unknown as ContentCatalogV4['assets'] }, labeled, addressed, changed: labeled.length + addressed.length > 0 };
}

/** The notes the open reports (Problems) for an upgrade that labeled or moved anything. */
export function loadabilityNotes(u: LoadabilityUpgrade): string[] {
  const notes: string[] = [];
  if (u.labeled.length > 0) {
    const ids = u.labeled.map((l) => l.assetId);
    notes.push(`${ids.length} asset${ids.length === 1 ? '' : 's'} a script names by id got the label "${SCRIPT_NAMED_LABEL}", so builds keep shipping ${ids.length === 1 ? 'it' : 'them'} (${UPGRADE_REPORT_FILE} lists them): ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ', …' : ''}`);
  }
  if (u.addressed.length > 0) notes.push(`${u.addressed.length} asset address${u.addressed.length === 1 ? '' : 'es'} moved into the asset record (sidecar format 3)`);
  return notes;
}

/** Add the labeled assets to the project's upgrade report (next to project.json), keeping what it already says. */
export function writeLoadabilityReport(ops: WriteOps, dir: string, u: LoadabilityUpgrade, at: string): void {
  if (u.labeled.length === 0) return;
  const target = join(dir, UPGRADE_REPORT_FILE);
  let report: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(ops.readFile(target))) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) report = parsed as Record<string, unknown>;
  } catch {
    // no report yet (or not one this build reads): a new one
  }
  report['scriptNamed'] = { at, label: SCRIPT_NAMED_LABEL, why: 'a script names these assets by id; a build ships only what scenes reference and what has an address or a label', assets: u.labeled };
  // Advisory: the labels are in the sidecars and the note is in Problems, so a failed write is not an error.
  writeAtomic({ dir, target, bytes: new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`), allowedPreHashes: [], previousHash: null, ops });
}
