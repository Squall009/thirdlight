/**
 * The file check: the game folder is the truth for assets, and the backend
 * brings the catalog in step with it when it notices a change (the editor
 * asks when it opens a project, when its window gets focus back and on
 * "check files"; MCP can ask too).
 *
 * - A file moved outside the editor together with its `.tlasset` sidecar is
 *   the same asset: the record takes the new path (`setAssetOptions
 *   {sourcePath}`), so every reference keeps working.
 * - A file whose bytes changed is imported again (`publishAsset` reimport):
 *   inspected where it is, or converted first (FBX to GLB, PNG/JPEG to KTX2
 *   with its encoding), what the importer made going into the import cache.
 * - What the import cache should hold but does not (a fresh clone, a cleared
 *   cache) is made again from the file. The same runs before Play and export.
 *
 * Each change is an ordinary command, so it goes out on the change feed and
 * can be undone. Nothing here writes project state itself.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { AUDIO_PCM_WAV_TOOLCHAIN, FONT_TOOLCHAIN, IMAGE_TOOLCHAIN, M2_GLTF_TOOLCHAIN, MUSIC_TOOLCHAIN, type ImportJobPort } from '@thirdlight/asset-pipeline';
import { importKeyOfConverted, type AssetFileEntry, type ImportHeader, type MutationSuccess, type ResourceCheckReport, type StageInspector, type WorkspaceService } from '@thirdlight/workspace';

import type { FbxConverter } from './fbx';
import { KTX2_ENCODER, type Ktx2Mode, type TextureEncoder } from './texture-encode';

/** What one check did. */
export interface AssetFileCheckReport {
  relocated: { assetId: string; from: string | null; to: string }[];
  reimported: { assetId: string; file: string; version: number }[];
  rebuilt: { assetId: string; file: string }[];
  failed: { assetId: string; file: string | null; code: string; message: string }[];
  sidecarProblems: string[];
  /** The project's resource and scene files: moves followed, files adopted, reloaded or removed (one `importResources`), problems. */
  resources: ResourceCheckReport | null;
}

export interface AssetFileCheckDeps {
  service: WorkspaceService;
  inspector: StageInspector;
  fbx?: FbxConverter;
  textureEncoder?: TextureEncoder;
  now: () => number;
  /** A command the check ran was applied (the change feed). */
  onApplied: (projectId: string, result: MutationSuccess) => void;
}

type Kind = 'model' | 'audio' | 'texture' | 'music' | 'font';

/** The inspector's toolchain per kind, as an import-cache version tag. */
function toolchainTag(kind: string): string {
  const t: Readonly<Record<string, string>> =
    kind === 'audio' ? AUDIO_PCM_WAV_TOOLCHAIN : kind === 'texture' ? IMAGE_TOOLCHAIN : kind === 'music' ? MUSIC_TOOLCHAIN : kind === 'font' ? FONT_TOOLCHAIN : M2_GLTF_TOOLCHAIN;
  return Object.entries(t)
    .map(([k, v]) => `${k}-${v}`)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 64);
}

function hex(n: number): string {
  return randomBytes(n).toString('hex');
}

function utcSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type Facts = { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown };

export function createAssetFileCheck(deps: AssetFileCheckDeps) {
  const { service } = deps;
  /** One check at a time per project (a focus during a long conversion waits for it). */
  const running = new Map<string, Promise<{ ok: true; report: AssetFileCheckReport } | { ok: false; code: string; message: string }>>();

  const job = (displayName?: string): ImportJobPort => {
    const expires = utcSecond(deps.now() + 3_600_000);
    return {
      now: () => deps.now(),
      isCancelled: () => false,
      proposalId: () => `p-${hex(16)}`,
      stageId: () => 'file-check',
      expiresAt: () => expires,
      ...(displayName !== undefined ? { suggestedDisplayName: displayName } : {}),
    };
  };

  /** Run one command at the current revision; the result goes out on the change feed. */
  const command = (projectId: string, op: string, args: Record<string, unknown>): { ok: true; result: MutationSuccess } | { ok: false; code: string; message: string } => {
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return { ok: false, code: captured.error.code, message: captured.error.message ?? captured.error.code };
    const r = service.runCommand({ op, projectId, expectedRevision: captured.read.revision, requestId: `req-${hex(16)}`, origin: { kind: 'admin', clientId: 'file-check' }, args });
    if (!r.ok) return { ok: false, code: r.error.code, message: r.error.message ?? r.error.code };
    deps.onApplied(projectId, r);
    return { ok: true, result: r };
  };

  /** Inspect bytes an importer made (a GLB, a KTX2): the facts a publish records. */
  const inspectBytes = (bytes: Uint8Array, kind: Kind): Facts | { code: string; message: string } => {
    const p = deps.inspector(bytes, job(), { kind }) as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown; diagnostics?: { message?: string }[] };
    if (p.status !== 'ok') return { code: 'import_rejected', message: p.diagnostics?.[0]?.message ?? 'the imported data was not accepted' };
    return { sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics };
  };

  /** Inspect a file where it is (the header cache first: the same bytes were seen before). */
  const inspectFile = (projectId: string, file: string, kind: Kind, digest: string | null): Facts | { code: string; message: string } => {
    const tag = toolchainTag(kind);
    if (digest !== null) {
      const h = service.readImportHeader(projectId, digest, kind, tag);
      if (h !== null) return { sourceDigest: h.sourceDigest, sourceByteLength: h.sourceByteLength, importRecipe: h.importRecipe, metrics: h.metrics };
    }
    const r = service.inspectProjectFile(projectId, file, { kind });
    if (!r.ok) return { code: r.error.code, message: r.error.message ?? r.error.code };
    const p = r.proposal as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown };
    if (p.status !== 'ok') return { code: 'import_rejected', message: `${file} was not accepted by the importer` };
    const header: ImportHeader = { kind, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics };
    service.writeImportHeader(projectId, header, tag);
    return { sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics };
  };

  /**
   * Convert a file again (FBX to GLB, PNG/JPEG to KTX2 as its sidecar says);
   * what the importer made goes into the import cache. Returns the new
   * `convertedFrom` and the facts of the made bytes.
   */
  const convertFile = async (projectId: string, file: string, conv: { format: string; encoding?: string }, kind: Kind): Promise<{ convertedFrom: Record<string, unknown>; facts: Facts } | { code: string; message: string }> => {
    const src = service.conversionSource(projectId, file);
    if (!src.ok) return { code: src.error.code, message: src.error.message ?? src.error.code };
    let made: Uint8Array;
    let converter: { name: string; version: string };
    if (conv.encoding !== undefined) {
      const encoder = deps.textureEncoder;
      if (encoder === undefined) return { code: 'converter_unavailable', message: 'KTX2 encoding is not available on this server' };
      const encoded = await encoder.encode(new Uint8Array(readFileSync(src.real)), conv.encoding as Ktx2Mode);
      if (!encoded.ok) return { code: 'conversion_failed', message: encoded.message };
      made = encoded.ktx2;
      conv = { ...conv, format: encoded.source.format };
      converter = { name: KTX2_ENCODER.name, version: KTX2_ENCODER.version };
    } else {
      const fbx = deps.fbx;
      if (fbx === undefined) return { code: 'converter_unavailable', message: 'FBX import needs Blender on the server (THIRDLIGHT_BLENDER)' };
      const converted = await fbx.convert({ path: src.real });
      if (!converted.ok) return { code: converted.code, message: converted.message };
      made = converted.glb;
      converter = { name: 'blender', version: converted.blenderVersion };
    }
    const again = service.conversionSource(projectId, file);
    if (!again.ok || again.digest !== src.digest) return { code: 'asset_source_changed', message: `${file} changed while it was converted; the next check imports it` };
    const convertedFrom = {
      format: conv.format,
      sourceDigest: src.digest,
      sourceByteLength: src.byteLength,
      sourcePath: file,
      converter,
      ...(conv.encoding !== undefined ? { encoding: conv.encoding } : {}),
    };
    const stored = service.writeImportedArtifact(projectId, importKeyOfConverted(convertedFrom as Parameters<typeof importKeyOfConverted>[0]), made);
    if (!stored.ok) return { code: stored.error.code, message: stored.error.message ?? stored.error.code };
    const facts = inspectBytes(made, kind);
    if ('code' in facts) return facts;
    return { convertedFrom, facts };
  };

  /** Import a changed file again: one `publishAsset` reimport with the file's new facts. */
  const reimport = async (projectId: string, e: AssetFileEntry, report: AssetFileCheckReport): Promise<void> => {
    const file = e.file!;
    const fail = (code: string, message: string): void => void report.failed.push({ assetId: e.assetId, file, code, message });
    if (e.animated === true) return fail('animation_mapping_required', `${file} changed; the asset's animation roles must be chosen again: re-import it from the Assets tab`);
    let args: Record<string, unknown>;
    if (e.converted !== undefined) {
      const c = await convertFile(projectId, file, e.converted, e.kind as Kind);
      if ('code' in c) return fail(c.code, c.message);
      args = { convertedFrom: c.convertedFrom, ...factsArgs(c.facts) };
    } else {
      const f = inspectFile(projectId, file, e.kind as Kind, e.foundDigest ?? null);
      if ('code' in f) return fail(f.code, f.message);
      args = { sourcePath: file, ...factsArgs(f) };
    }
    const r = command(projectId, 'publishAsset', { mode: 'reimport', assetId: e.assetId, ...args, importedAt: utcSecond(deps.now()) });
    if (!r.ok) return fail(r.code, r.message);
    const next = (r.result.change as { next?: { currentVersion?: number } }).next;
    report.reimported.push({ assetId: e.assetId, file, version: next?.currentVersion ?? e.version + 1 });
  };

  /** Make a converted asset's cached data again; bytes that differ from the recorded ones are a re-import. */
  const rebuild = async (projectId: string, e: AssetFileEntry, report: AssetFileCheckReport): Promise<void> => {
    const c = await convertFile(projectId, e.file!, e.converted!, e.kind as Kind);
    if ('code' in c) {
      report.failed.push({ assetId: e.assetId, file: e.file, code: c.code, message: `the imported data could not be made again: ${c.message}` });
      return;
    }
    const recorded = service.readBlob(projectId, { assetId: e.assetId, version: e.version });
    if (recorded.ok) {
      report.rebuilt.push({ assetId: e.assetId, file: e.file! });
      return;
    }
    // The converter made other bytes (another Blender, another encoder): record them as the asset's data.
    const r = command(projectId, 'publishAsset', { mode: 'reimport', assetId: e.assetId, convertedFrom: c.convertedFrom, ...factsArgs(c.facts), importedAt: utcSecond(deps.now()) });
    if (!r.ok) {
      report.failed.push({ assetId: e.assetId, file: e.file, code: r.code, message: r.message });
      return;
    }
    const next = (r.result.change as { next?: { currentVersion?: number } }).next;
    report.reimported.push({ assetId: e.assetId, file: e.file!, version: next?.currentVersion ?? e.version + 1 });
  };

  async function runCheck(projectId: string, options: { reimport: boolean; relocate: boolean }): Promise<{ ok: true; report: AssetFileCheckReport } | { ok: false; code: string; message: string }> {
    const report: AssetFileCheckReport = { relocated: [], reimported: [], rebuilt: [], failed: [], sidecarProblems: [], resources: null };
    // Resource and scene files first (a material a new file brings may name an asset the check re-imports next).
    if (options.relocate) {
      const r = service.checkResourceFiles(projectId);
      if (r.ok) {
        report.resources = r.report;
        if (r.prepared) {
          const applied = command(projectId, 'importResources', {});
          if (!applied.ok) {
            // Nothing came in: the files stay as they are and say why; the next check tries again.
            r.report.problems.push({ path: '', message: `the resource files found could not come in together: ${applied.message}` });
            r.report.adopted = [];
            r.report.reloaded = [];
            r.report.removed = [];
          }
        }
      }
    }
    let files = service.assetFiles(projectId);
    if (!files.ok) return { ok: false, code: files.error.code, message: files.error.message ?? files.error.code };
    const missing = files.entries.filter((e) => e.status === 'missing');
    if (options.relocate && missing.length > 0) {
      const found = service.findMovedAssets(projectId, missing.map((e) => e.assetId));
      if (found.ok) {
        for (const e of missing) {
          const to = found.found[e.assetId];
          if (to === undefined) continue;
          const r = command(projectId, 'setAssetOptions', { assetId: e.assetId, sourcePath: to });
          if (r.ok) report.relocated.push({ assetId: e.assetId, from: e.file, to });
          else report.failed.push({ assetId: e.assetId, file: e.file, code: r.code, message: r.message });
        }
      }
      if (report.relocated.length > 0) {
        files = service.assetFiles(projectId);
        if (!files.ok) return { ok: false, code: files.error.code, message: files.error.message ?? files.error.code };
      }
    }
    report.sidecarProblems = files.sidecarProblems;
    for (const e of files.entries) {
      if (e.file === null) continue;
      if (e.status === 'changed' && options.reimport) await reimport(projectId, e, report);
      else if (e.status === 'ok' && e.converted?.imported === 'missing') await rebuild(projectId, e, report);
    }
    return { ok: true, report };
  }

  const serialized = (projectId: string, options: { reimport: boolean; relocate: boolean }): ReturnType<typeof runCheck> => {
    const before = running.get(projectId) ?? Promise.resolve(null);
    const next = before.then(() => runCheck(projectId, options), () => runCheck(projectId, options));
    running.set(projectId, next);
    void next.finally(() => {
      if (running.get(projectId) === next) running.delete(projectId);
    });
    return next;
  };

  /**
   * Import a new file where it is: the facts a `publishAsset` create (or a
   * folder import) records. An FBX is converted to GLB first, a PNG/JPEG with
   * a KTX2 setting encoded; what the importer made goes into the import
   * cache. A WAV the short-sound profile refuses is taken as the longer-audio
   * kind, the one that takes any length.
   */
  const importFile = async (projectId: string, file: string, kind: Kind, options: { ktx2?: Ktx2Mode } = {}): Promise<{ kind: Kind; args: Record<string, unknown> } | { code: string; message: string }> => {
    if (kind === 'model' && /\.fbx$/i.test(file)) {
      const c = await convertFile(projectId, file, { format: 'fbx' }, 'model');
      return 'code' in c ? c : { kind, args: { convertedFrom: c.convertedFrom, ...factsArgs(c.facts) } };
    }
    if (kind === 'texture' && options.ktx2 !== undefined && /\.(png|jpe?g)$/i.test(file)) {
      const c = await convertFile(projectId, file, { format: /\.png$/i.test(file) ? 'png' : 'jpeg', encoding: options.ktx2 }, 'texture');
      return 'code' in c ? c : { kind, args: { convertedFrom: c.convertedFrom, ...factsArgs(c.facts) } };
    }
    const f = inspectFile(projectId, file, kind, null);
    if ('code' in f) {
      if (kind === 'audio') {
        const longer = inspectFile(projectId, file, 'music', null);
        if (!('code' in longer)) return { kind: 'music', args: { sourcePath: file, ...factsArgs(longer) } };
      }
      return f;
    }
    return { kind, args: { sourcePath: file, ...factsArgs(f) } };
  };

  return {
    importFile,
    /** The whole check: moved files found by their sidecars, changed files imported again, the import cache made whole. */
    check: (projectId: string) => serialized(projectId, { reimport: true, relocate: true }),
    /** Before Play and export: only the import cache is made whole (the build reads what the catalog records). */
    ensureImported: async (projectId: string): Promise<void> => {
      await serialized(projectId, { reimport: false, relocate: false });
    },
  };
}

function factsArgs(f: Facts): Record<string, unknown> {
  return { sourceDigest: f.sourceDigest, sourceByteLength: f.sourceByteLength, importRecipe: f.importRecipe, metrics: f.metrics };
}

export type AssetFileCheck = ReturnType<typeof createAssetFileCheck>;
