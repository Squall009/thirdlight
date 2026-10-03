/**
 * Models still holding images inside their files, when the project extracts
 * every model's (`import_extract_textures` 1).
 *
 * An image inside a model is decoded to plain RGBA for every model that
 * carries it; extracted, it is one compressed KTX2 texture asset the models
 * share and the texture budget streams. With the setting on, the backend
 * extracts each such model where its GLB file is (the same step as a changed
 * file's re-import: one `publishAsset` each, so it is on the change feed and
 * can be undone), once per file version, and Problems lists the models left
 * and why: no file in the game folder, converted from another format, or the
 * extraction's own reason.
 *
 * Checked when the project loads and after a change that can change the
 * answer (the setting, an asset added, re-imported or removed). The Problem is
 * logged when the list changes and is not empty.
 */
import { extractTexturesEverywhere } from '@thirdlight/project-model/limits';
import type { WorkspaceService } from '@thirdlight/workspace';

/** The change types that can change which models hold images or whether they should not. */
const RELEVANT = new Set(['setSettings', 'publishAsset', 'importAssets', 'removeAsset', 'setAssetOptions']);

/** Models named in one Problem line (the count says how many). */
const NAMED_PER_LINE = 6;

export interface HeldImagesRow {
  readonly assetId: string;
  /** Images still inside the model's stored file. */
  readonly held: number;
  /** The GLB file in the game folder the images can be extracted from (absent: none). */
  readonly file?: string;
  /** The model file's digest (one extraction attempt per file version). */
  readonly digest: string;
  /** Why the images stay inside (absent: they can be extracted). */
  readonly reason?: string;
}

interface ModelRecordLike {
  assetId: string;
  kind?: string;
  currentVersion: number;
  textures?: Record<string, string>;
  versions: { version: number; sourceDigest: string; sourcePath?: string; convertedFrom?: { format?: string; sourceDigest: string; sourcePath?: string }; metrics?: { images?: number } }[];
}

/** Every model whose stored file holds images no texture asset stands for. */
export function heldImageModels(content: unknown): HeldImagesRow[] {
  const assets = ((content as { assets?: ModelRecordLike[] } | null)?.assets ?? []) as ModelRecordLike[];
  const rows: HeldImagesRow[] = [];
  for (const a of assets) {
    if (a.kind !== 'model') continue;
    const v = a.versions.find((x) => x.version === a.currentVersion);
    const images = v?.metrics?.images ?? 0;
    const held = images - Object.keys(a.textures ?? {}).length;
    if (v === undefined || held <= 0) continue;
    const c = v.convertedFrom;
    if (c === undefined && v.sourcePath !== undefined && /\.glb$/i.test(v.sourcePath)) rows.push({ assetId: a.assetId, held, file: v.sourcePath, digest: v.sourceDigest });
    else if (c?.format === 'glb') rows.push({ assetId: a.assetId, held, digest: c.sourceDigest, reason: 'some of its images could not be extracted (its import report says why)' });
    else if (c !== undefined) rows.push({ assetId: a.assetId, held, digest: c.sourceDigest, reason: `converted from ${String(c.format).toUpperCase()}: its images stay in the converted file` });
    else rows.push({ assetId: a.assetId, held, digest: v.sourceDigest, reason: 'its file is not in the game folder: import it again from a file' });
  }
  return rows;
}

export function heldImagesProblemLine(rows: readonly HeldImagesRow[]): string {
  const shown = rows.slice(0, NAMED_PER_LINE).map((r) => `"${r.assetId}" (${r.held} image${r.held === 1 ? '' : 's'}: ${r.reason ?? 'not extracted yet'})`);
  const what = rows.length === 1 ? 'A model still holds images inside its file' : `${rows.length} models still hold images inside their files`;
  return `${what}: ${shown.join(', ')}${rows.length > NAMED_PER_LINE ? ', …' : ''}. Each such image is drawn uncompressed per model; the project extracts every model's images (setting import_extract_textures).`;
}

export interface HeldImagesChecker {
  /** Check now: start the extraction of what can be extracted, log what is left. Null: the project cannot be read. */
  check(projectId: string): HeldImagesRow[] | null;
  /** The project loaded: check it unless it was checked. */
  loaded(projectId: string): void;
  /** After an applied change: check soon when the change can matter. */
  changed(projectId: string, change: unknown): void;
}

export function createHeldImagesChecker(deps: {
  service: Pick<WorkspaceService, 'readCapturedV3'>;
  /** Extract these models' images where their files are (after any file check running). */
  extract: (projectId: string, models: readonly { assetId: string; file: string }[]) => Promise<{ failed: readonly { assetId: string; message: string }[] }>;
  recordProblem: (projectId: string, code: string, message: string) => void;
  logStartup: (line: string) => void;
  closed: () => boolean;
}): HeldImagesChecker {
  const last = new Map<string, string>();
  /** `<assetId>|<file digest>` extractions started: one attempt per file version (a failure is not retried in a loop). */
  const attempted = new Map<string, Map<string, string | null>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();

  const schedule = (projectId: string): void => {
    if (deps.closed() || timers.has(projectId)) return;
    const t = setTimeout(() => {
      timers.delete(projectId);
      if (!deps.closed()) safeCheck(projectId);
    }, 25);
    (t as { unref?: () => void }).unref?.();
    timers.set(projectId, t);
  };

  const check = (projectId: string): HeldImagesRow[] | null => {
    const captured = deps.service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const content = captured.read.content as { settings?: unknown } | null;
    if (!extractTexturesEverywhere(content?.settings)) {
      last.delete(projectId);
      return [];
    }
    const tried = attempted.get(projectId) ?? new Map<string, string | null>();
    attempted.set(projectId, tried);
    const rows = heldImageModels(content).map((r): HeldImagesRow => {
      if (r.reason !== undefined || r.file === undefined) return r;
      const failure = tried.get(`${r.assetId}|${r.digest}`);
      return typeof failure === 'string' ? { ...r, reason: failure } : r;
    });
    const todo = rows.filter((r) => r.reason === undefined && r.file !== undefined && !tried.has(`${r.assetId}|${r.digest}`));
    if (todo.length > 0 && !running.has(projectId)) {
      for (const r of todo) tried.set(`${r.assetId}|${r.digest}`, null);
      running.add(projectId);
      void deps
        .extract(projectId, todo.map((r) => ({ assetId: r.assetId, file: r.file! })))
        .then(
          (out) => {
            // A model the extraction went through but left holding images (nothing it could take out) keeps that reason.
            for (const r of todo) tried.set(`${r.assetId}|${r.digest}`, 'the extraction left them inside (its import report says why)');
            for (const f of out.failed) {
              const r = todo.find((x) => x.assetId === f.assetId);
              if (r !== undefined) tried.set(`${r.assetId}|${r.digest}`, `not extracted: ${f.message}`);
            }
          },
          (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            for (const r of todo) tried.set(`${r.assetId}|${r.digest}`, `not extracted: ${message}`);
            deps.logStartup(`extracting the images of ${projectId}'s models failed: ${message}`);
          },
        )
        .finally(() => {
          running.delete(projectId);
          schedule(projectId);
        });
      return rows;
    }
    // Not reported while an extraction runs: the list is the one it leaves.
    if (running.has(projectId)) return rows;
    const left = rows.filter((r) => r.reason !== undefined);
    const key = JSON.stringify(left);
    if (last.get(projectId) !== key) {
      last.set(projectId, key);
      if (left.length > 0) deps.recordProblem(projectId, 'models_hold_images', heldImagesProblemLine(left));
    }
    return rows;
  };

  const safeCheck = (projectId: string): void => {
    try {
      check(projectId);
    } catch (e) {
      deps.logStartup(`held-images check of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    check,
    loaded(projectId) {
      if (!last.has(projectId)) safeCheck(projectId);
    },
    changed(projectId, change) {
      const type = (change as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && RELEVANT.has(type)) schedule(projectId);
    },
  };
}
