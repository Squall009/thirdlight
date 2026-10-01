/**
 * "Extract textures": a model's import setting that takes the images out of
 * its GLB and makes them texture assets the model draws with (Godot's glTF
 * importer extracts by default; Unity's model importer has "Extract
 * Textures"). The textures are then like any texture asset: counted in the
 * texture budget, streamed by mip when they are KTX2 with a chain, shared by
 * every model whose file carries the same image.
 *
 * An extraction:
 *
 * 1. reads the GLB's images (`glb-images.ts`) and, for each, finds the
 *    texture asset already made from the same bytes with the same encoding
 *    (another model's, or this model's before a re-import), or writes the
 *    image as a file of the game folder (`<model folder>/<model>_textures/`)
 *    and prepares its import: a PNG or JPEG is encoded to KTX2 with mips
 *    (colour, normal map or data, from what the materials sample it as; one
 *    image at a time on the encoder worker, so the backend holds at most one
 *    encode's pixels), a KTX2 or WebP file and an image over the encoder's
 *    pixel limit come in as they are;
 * 2. writes the GLB without those images (one-pixel stand-ins) into the
 *    import cache: the model version's stored bytes, converted from the GLB
 *    (`convertedFrom: {format: "glb", converter: texture-extract}`), so a
 *    cleared cache is made again from the file;
 * 3. brings the new texture files in with one `importAssets` and publishes
 *    the model with `textures` (image index → texture asset id).
 *
 * An image whose texture cannot be made stays inside the file (and is
 * counted with the model, as before); the report says why. Nothing here
 * writes project state except through those commands.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { DEFAULT_ASSET_FOLDER, assetNameOfFile, fileStem, importKeyOfConverted, type PreparedImportFile, type StageInspector, type WorkspaceService } from '@thirdlight/workspace';
import type { ImportJobPort } from '@thirdlight/asset-pipeline';

import { readGlbImages, stripGlbImages, type GlbImage } from './glb-images';
import { KTX2_ENCODER, type Ktx2Mode, type TextureEncoder } from './texture-encode';

/**
 * Whether a new model's import extracts its images when the request does not
 * say (an existing model keeps its own setting until a re-import changes it).
 */
export const EXTRACT_TEXTURES_ON_NEW_IMPORT = true;

/** The extraction's converter record (a new version when the stripped file it writes changes). */
export const TEXTURE_EXTRACT = { name: 'texture-extract', version: '1.0' } as const;

/** One image of an extraction: the texture it became, or why it stayed inside the file. */
export interface ExtractedImage {
  image: number;
  name: string | null;
  /** The texture's file in the game folder (absent: kept inside the model). */
  file?: string;
  /** An existing texture asset made from the same bytes was used. */
  reused?: boolean;
  /** The KTX2 encoding the image got (absent: imported as it is). */
  encoding?: Ktx2Mode;
  /** Why it stayed inside the file, or came in without a KTX2 encode. */
  note?: string;
}

/** What an extraction did, next to the publish's result. */
export interface TextureExtractionReport {
  images: ExtractedImage[];
  /** Texture assets this import created. */
  created: string[];
}

/** The facts the model's publish records. */
export interface ExtractedModelFacts {
  sourceDigest: string;
  sourceByteLength: number;
  importRecipe: unknown;
  metrics: unknown;
  convertedFrom: { format: 'glb'; sourceDigest: string; sourceByteLength: number; sourcePath?: string; converter: { name: string; version: string } };
}

export interface ExtractionPlan {
  /** The model's facts without the extracted images (null: nothing was extracted; the file is published as it is). */
  model: ExtractedModelFacts | null;
  /** The folder the texture files are in (the `importAssets` of the new ones). */
  folder: string;
  /** The new texture files' prepared imports. */
  files: PreparedImportFile[];
  /** Each extracted image's texture file (a new one, or an existing asset's). */
  imagePaths: Record<string, string>;
  /** Files written for this extraction (taken back when the import does not happen). */
  written: { path: string; digest: string }[];
  report: TextureExtractionReport;
}

export interface TextureExtractionDeps {
  service: WorkspaceService;
  inspector: StageInspector;
  textureEncoder?: TextureEncoder;
  now: () => number;
}

/** What `run` returns for a command the extraction sends. */
export type ExtractionCommandResult = { ok: true; revision: number; change: unknown } | { ok: false; code: string; message: string };

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function utcSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const EXT_OF: Readonly<Record<GlbImage['mime'], string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/ktx2': 'ktx2' };

/** A file name from an image's name (letters, digits, `-`, `_`, `.`), else `image-<index>`. */
function imageStem(image: GlbImage): string {
  const raw = (image.name ?? '').replace(/\.(png|jpe?g|webp|ktx2)$/i, '');
  const s = raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return s.length > 0 ? s : `image-${image.index}`;
}

/** The KTX2 encoding of an image from what the materials sample it as (several: the most exact). */
function encodingOf(image: GlbImage): Ktx2Mode {
  if (image.roles.has('data') || (image.roles.has('normal') && image.roles.has('color'))) return 'data';
  if (image.roles.has('normal')) return 'normal';
  return 'color';
}

interface TextureRecordLike {
  assetId: string;
  kind?: string;
  currentVersion: number;
  versions: { version: number; sourceDigest: string; sourcePath?: string; convertedFrom?: { format?: string; sourceDigest: string; sourcePath?: string; encoding?: string } }[];
}

/** Every texture asset by the bytes of its file and how it was encoded (`<digest>|<encoding or "plain">`), with its file. */
function texturesByFile(assets: readonly TextureRecordLike[]): Map<string, { assetId: string; path: string }> {
  const out = new Map<string, { assetId: string; path: string }>();
  for (const a of assets) {
    if (a.kind !== 'texture') continue;
    const v = a.versions.find((x) => x.version === a.currentVersion);
    if (v === undefined) continue;
    const c = v.convertedFrom;
    if (c !== undefined && c.sourcePath !== undefined) out.set(`${c.sourceDigest}|${c.encoding ?? 'plain'}`, { assetId: a.assetId, path: c.sourcePath });
    else if (c === undefined && v.sourcePath !== undefined) out.set(`${v.sourceDigest}|plain`, { assetId: a.assetId, path: v.sourcePath });
  }
  return out;
}

export function createTextureExtraction(deps: TextureExtractionDeps) {
  const { service } = deps;

  const job = (): ImportJobPort => {
    const expires = utcSecond(deps.now() + 3_600_000);
    return { now: () => deps.now(), isCancelled: () => false, proposalId: () => `p-${randomBytes(16).toString('hex')}`, stageId: () => 'extract', expiresAt: () => expires };
  };
  const inspect = (bytes: Uint8Array, kind: 'model' | 'texture'): { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown } | { message: string } => {
    const p = deps.inspector(bytes, job(), { kind }) as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown; diagnostics?: { message?: string }[] };
    if (p.status !== 'ok') return { message: p.diagnostics?.[0]?.message ?? 'the importer did not accept it' };
    return { sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics };
  };

  /**
   * Write a texture file at the first free `<folder>/<stem>[-n].<ext>` (the same
   * bytes already there are that file). Null: the folder takes no files.
   */
  const place = (projectId: string, folder: string, stem: string, ext: string, bytes: Uint8Array, taken: ReadonlySet<string>): { path: string; written: boolean } | null => {
    for (let n = 1; n < 1000; n += 1) {
      const path = `${folder}/${n === 1 ? stem : `${stem}-${n}`}.${ext}`;
      if (taken.has(path.toLowerCase())) continue;
      const w = service.writeUploadedFile(projectId, path, bytes);
      if (w.ok) return { path, written: w.written };
      if (w.error.code !== 'path_rejected' || !/already holds another file|cannot be replaced/.test(w.error.message ?? '')) return null;
    }
    return null;
  };

  /**
   * Plan the extraction of `glb` (the model file's bytes): texture files
   * written, encoded and inspected, the stripped GLB in the import cache.
   * Nothing is imported yet.
   */
  async function plan(
    projectId: string,
    input: { glb: Uint8Array; original: { sourceDigest: string; sourceByteLength: number; sourcePath?: string }; folder: string; stem: string },
  ): Promise<{ ok: true; plan: ExtractionPlan } | { ok: false; code: string; message: string }> {
    const read = readGlbImages(input.glb);
    if (!read.ok) return { ok: false, code: 'import_rejected', message: `the model's images could not be read: ${read.message}` };
    const folder = `${input.folder}/${input.stem}_textures`;
    const report: TextureExtractionReport = { images: [], created: [] };
    const empty: ExtractionPlan = { model: null, folder, files: [], imagePaths: {}, written: [], report };
    if (read.images.length === 0) return { ok: true, plan: empty };
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return { ok: false, code: captured.error.code, message: captured.error.message ?? captured.error.code };
    const assets = ((captured.read as unknown as { content?: { assets?: TextureRecordLike[] } }).content?.assets ?? []) as TextureRecordLike[];
    const byFile = texturesByFile(assets);
    const taken = new Set<string>();
    for (const a of assets) for (const v of a.versions) for (const p of [v.sourcePath, v.convertedFrom?.sourcePath]) if (p !== undefined) taken.add(p.toLowerCase());
    const importedAt = utcSecond(deps.now());
    const files: PreparedImportFile[] = [];
    const imagePaths: Record<string, string> = {};
    const written: { path: string; digest: string }[] = [];
    /** An image whose bytes and encoding were seen earlier in this file: the same texture. */
    const madeHere = new Map<string, string>();
    for (const image of read.images) {
      const digest = sha256(image.bytes);
      const encodable = image.mime === 'image/png' || image.mime === 'image/jpeg';
      let mode: Ktx2Mode | null = encodable ? encodingOf(image) : null;
      const entry: ExtractedImage = { image: image.index, name: image.name };
      report.images.push(entry);
      const known = madeHere.get(`${digest}|${mode ?? 'plain'}`) ?? byFile.get(`${digest}|${mode ?? 'plain'}`)?.path;
      if (known !== undefined) {
        imagePaths[String(image.index)] = known;
        entry.file = known;
        entry.reused = true;
        if (mode !== null) entry.encoding = mode;
        continue;
      }
      const placed = place(projectId, folder, imageStem(image), EXT_OF[image.mime], image.bytes, taken);
      if (placed === null) {
        entry.note = `the file could not be written into ${folder}`;
        continue;
      }
      const takeBack = (): void => {
        if (placed.written) service.removeWrittenFile(projectId, placed.path, digest);
      };
      if (placed.written) written.push({ path: placed.path, digest });
      // The file may already be another texture asset's (written by an earlier extraction and imported).
      const existing = assets.find((a) => a.kind === 'texture' && a.versions.some((v) => (v.convertedFrom?.sourcePath ?? v.sourcePath)?.toLowerCase() === placed.path.toLowerCase()));
      if (existing !== undefined) {
        imagePaths[String(image.index)] = placed.path;
        entry.file = placed.path;
        entry.reused = true;
        continue;
      }
      let args: Record<string, unknown> | null = null;
      if (mode !== null) {
        const encoder = deps.textureEncoder;
        const encoded = encoder === undefined ? null : await encoder.encode(image.bytes, mode);
        if (encoded !== null && encoded.ok) {
          const convertedFrom = { format: encoded.source.format, sourceDigest: digest, sourceByteLength: image.bytes.length, sourcePath: placed.path, converter: { name: KTX2_ENCODER.name, version: KTX2_ENCODER.version }, encoding: mode };
          const stored = service.writeImportedArtifact(projectId, importKeyOfConverted(convertedFrom), encoded.ktx2);
          const facts = stored.ok ? inspect(encoded.ktx2, 'texture') : { message: stored.error.message ?? stored.error.code };
          if ('sourceDigest' in facts) args = { convertedFrom, ...facts };
          else entry.note = `the KTX2 was not accepted: ${facts.message}`;
        } else {
          // Over the encoder's pixel limit (or no encoder here): the image comes in as it is, without a mip chain to stream.
          entry.note = encoded === null ? 'no KTX2 encoder on this server: imported as it is' : `not encoded to KTX2 (${encoded.message}): imported as it is`;
          mode = null;
        }
      }
      if (args === null && mode === null) {
        const facts = inspect(image.bytes, 'texture');
        if ('sourceDigest' in facts) args = { sourcePath: placed.path, ...facts };
        else entry.note = `the image was not accepted as a texture: ${facts.message}`;
      }
      if (args === null) {
        takeBack();
        if (placed.written) written.pop();
        continue;
      }
      taken.add(placed.path.toLowerCase());
      madeHere.set(`${digest}|${mode ?? 'plain'}`, placed.path);
      files.push({ path: placed.path, idHint: null, labels: [], item: { kind: 'texture', displayName: assetNameOfFile(placed.path), importedAt, ...args } as PreparedImportFile['item'] });
      imagePaths[String(image.index)] = placed.path;
      entry.file = placed.path;
      if (mode !== null) entry.encoding = mode;
    }
    const extracted = new Set(Object.keys(imagePaths).map(Number));
    const abandon = (message: string): { ok: true; plan: ExtractionPlan } => {
      for (const w of written) service.removeWrittenFile(projectId, w.path, w.digest);
      for (const e of report.images) {
        delete e.file;
        delete e.reused;
        delete e.encoding;
        e.note = message;
      }
      return { ok: true, plan: empty };
    };
    if (extracted.size === 0) return { ok: true, plan: { ...empty, report } };
    const stripped = stripGlbImages(input.glb, read.images, extracted);
    if (stripped === null) return abandon('the file\'s binary layout shares an image\'s bytes with other data: the images stay inside');
    const convertedFrom: ExtractedModelFacts['convertedFrom'] = {
      format: 'glb',
      sourceDigest: input.original.sourceDigest,
      sourceByteLength: input.original.sourceByteLength,
      ...(input.original.sourcePath !== undefined ? { sourcePath: input.original.sourcePath } : {}),
      converter: { name: TEXTURE_EXTRACT.name, version: TEXTURE_EXTRACT.version },
    };
    const stored = service.writeImportedArtifact(projectId, importKeyOfConverted(convertedFrom), stripped);
    if (!stored.ok) return abandon(`the model without its images could not be stored: ${stored.error.message ?? stored.error.code}`);
    const facts = inspect(stripped, 'model');
    if (!('sourceDigest' in facts)) return abandon(`the model without its images was not accepted: ${facts.message}`);
    return { ok: true, plan: { model: { ...facts, convertedFrom }, folder, files, imagePaths, written, report } };
  }

  /**
   * Bring the plan's new texture files in (one `importAssets` through `run`)
   * and answer the model's `textures`. A refused import takes its files back.
   */
  function commit(projectId: string, p: ExtractionPlan, run: (op: string, args: Record<string, unknown>) => ExtractionCommandResult): { ok: true; textures: Record<string, string> } | { ok: false; code: string; message: string } {
    if (p.files.length > 0) {
      const prepared = service.prepareAssetImport(projectId, p.folder, p.files);
      if (!prepared.ok) return discard(projectId, p, prepared.error.code, prepared.error.message ?? prepared.error.code);
      const r = run('importAssets', { folder: p.folder });
      if (!r.ok) return discard(projectId, p, r.code, `the model's textures could not be imported: ${r.message}`);
      const added = (r.change as { added?: { assetId: string }[] }).added ?? [];
      p.report.created = added.map((a) => a.assetId);
    }
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return { ok: false, code: captured.error.code, message: captured.error.message ?? captured.error.code };
    const assets = ((captured.read as unknown as { content?: { assets?: TextureRecordLike[] } }).content?.assets ?? []) as TextureRecordLike[];
    const idOfPath = new Map<string, string>();
    for (const a of assets) {
      if (a.kind !== 'texture') continue;
      const v = a.versions.find((x) => x.version === a.currentVersion);
      const path = v?.convertedFrom?.sourcePath ?? v?.sourcePath;
      if (path !== undefined) idOfPath.set(path.toLowerCase(), a.assetId);
    }
    const textures: Record<string, string> = {};
    for (const [image, path] of Object.entries(p.imagePaths)) {
      const id = idOfPath.get(path.toLowerCase());
      if (id === undefined) return { ok: false, code: 'asset_reference_missing', message: `the texture extracted from image ${image} (${path}) is not an asset of the project` };
      textures[image] = id;
    }
    return { ok: true, textures };
  }

  function discard(projectId: string, p: ExtractionPlan, code: string, message: string): { ok: false; code: string; message: string } {
    for (const w of p.written) service.removeWrittenFile(projectId, w.path, w.digest);
    return { ok: false, code, message };
  }

  /** The bytes of a model file in the game folder, checked against its digest (null: missing or changed). */
  function readModelFile(projectId: string, path: string, digest: string): Uint8Array | null {
    const src = service.conversionSource(projectId, path);
    if (!src.ok || src.digest !== digest) return null;
    const bytes = new Uint8Array(readFileSync(src.real));
    return sha256(bytes) === digest ? bytes : null;
  }

  /**
   * A `publishAsset` of a model whose "extract textures" setting is on (the
   * args say so; a new model by default; a re-import as its record says):
   * the plan, and the publish's args with the model's facts without the
   * extracted images (its `textures` come with the commit). Null: not a
   * model publish to extract (the command runs as sent).
   */
  async function preparePublish(projectId: string, args: Record<string, unknown>): Promise<{ ok: true; plan: ExtractionPlan | null; args: Record<string, unknown> } | { ok: false; code: string; message: string } | null> {
    const assetId = args['assetId'];
    if (typeof assetId !== 'string' || args['textures'] !== undefined) return null;
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return null;
    const assets = ((captured.read.content as { assets?: (TextureRecordLike & { displayName?: string; extractTextures?: true })[] } | null)?.assets ?? []);
    const record = assets.find((a) => a.assetId === assetId);
    const create = args['mode'] === 'create';
    const isModel = create ? (args['kind'] ?? 'model') === 'model' && record === undefined : record?.kind === 'model';
    if (!isModel) return null;
    const on = typeof args['extractTextures'] === 'boolean' ? args['extractTextures'] : create ? EXTRACT_TEXTURES_ON_NEW_IMPORT : record?.extractTextures === true;
    if (!on) return null;
    // A model converted from another format (an FBX) keeps its images: its stored GLB is the converter's.
    if (args['convertedFrom'] !== undefined) {
      const { extractTextures: _setting, ...rest } = args;
      return { ok: true, plan: null, args: rest };
    }
    const sourcePath = typeof args['sourcePath'] === 'string' ? args['sourcePath'] : undefined;
    const digest = args['sourceDigest'];
    const length = args['sourceByteLength'];
    if (typeof digest !== 'string' || typeof length !== 'number') return null;
    const glb = sourcePath !== undefined ? readModelFile(projectId, sourcePath, digest) : service.readHeldBytes(projectId, digest);
    // Bytes that are not there are the command's to refuse.
    if (glb === null) return null;
    const current = record?.versions.find((v) => v.version === record.currentVersion);
    const existingFile = current?.convertedFrom?.sourcePath ?? current?.sourcePath;
    const dirOf = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/')));
    const folder = sourcePath !== undefined ? dirOf(sourcePath) : typeof args['folder'] === 'string' ? args['folder'] : existingFile !== undefined ? dirOf(existingFile) : DEFAULT_ASSET_FOLDER;
    const name = sourcePath !== undefined ? sourcePath.slice(sourcePath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '') : typeof args['displayName'] === 'string' ? args['displayName'] : (record?.displayName ?? assetId);
    const planned = await plan(projectId, { glb, original: { sourceDigest: digest, sourceByteLength: length, ...(sourcePath !== undefined ? { sourcePath } : {}) }, folder: folder === '' ? DEFAULT_ASSET_FOLDER : folder, stem: fileStem(name, assetId) });
    if (!planned.ok) return planned;
    const p = planned.plan;
    if (p.model === null) return { ok: true, plan: p, args: { ...args, extractTextures: true } };
    const { sourcePath: _path, ...rest } = args;
    return {
      ok: true,
      plan: p,
      args: { ...rest, sourceDigest: p.model.sourceDigest, sourceByteLength: p.model.sourceByteLength, importRecipe: p.model.importRecipe, metrics: p.model.metrics, convertedFrom: p.model.convertedFrom, extractTextures: true },
    };
  }

  /**
   * The command route's step before a `publishAsset`: extract, bring the
   * new textures in at the revision the publish was sent for (one
   * `importAssets`, its own request id derived from the publish's), and
   * prepare the publish to run with the model's facts and `textures` at the
   * following revision. The publish request itself runs as sent, so a retry
   * of it is the same request (the workspace answers it from its record).
   * Null: nothing to prepare.
   */
  async function beforePublish(
    projectId: string,
    envelope: Record<string, unknown>,
    run: (request: Record<string, unknown>) => ExtractionCommandResult,
  ): Promise<{ ok: true; report: TextureExtractionReport | null } | { ok: false; code: string; message: string } | null> {
    const args = envelope['args'];
    const requestId = envelope['requestId'];
    const expectedRevision = envelope['expectedRevision'];
    if (typeof args !== 'object' || args === null || Array.isArray(args) || typeof requestId !== 'string' || typeof expectedRevision !== 'number') return null;
    const prep = await preparePublish(projectId, args as Record<string, unknown>);
    if (prep === null || !prep.ok) return prep;
    const p = prep.plan;
    if (p === null || p.model === null) {
      service.preparePublish(projectId, requestId, { args: prep.args, expectedRevision });
      return { ok: true, report: p?.report ?? null };
    }
    let expected = expectedRevision;
    const committed = commit(projectId, p, (op, a) => {
      const r = run({ ...envelope, op, args: a, requestId: `req-${sha256(new TextEncoder().encode(`${requestId}:textures`)).slice(0, 32)}` });
      if (r.ok) expected = r.revision;
      return r;
    });
    if (!committed.ok) return committed;
    service.preparePublish(projectId, requestId, { args: { ...prep.args, textures: committed.textures }, expectedRevision: expected });
    return { ok: true, report: p.report };
  }

  return { plan, commit, discard, readModelFile, preparePublish, beforePublish };
}

export type TextureExtraction = ReturnType<typeof createTextureExtraction>;
