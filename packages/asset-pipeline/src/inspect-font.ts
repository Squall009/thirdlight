/**
 * Font import (phase 23.9a): a TrueType (.ttf), OpenType/CFF (.otf), WOFF2 or
 * WOFF file for the project UI (the page loads it through the browser
 * FontFace API; nothing here decodes glyphs).
 *
 * Like the other inspectors: bytes in, a bounded non-authoritative proposal
 * out. The magic bytes decide the format (never the file name); the header
 * and table directory must be self-consistent and inside the file. The family
 * name is read from the `name` table of an uncompressed sfnt (TTF/OTF) when
 * present; WOFF/WOFF2 tables are compressed, so no name is read there.
 */
import { resolveImportJob } from './inspect';
import { AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, M2_GLTF_MAX_DIAGNOSTICS } from './limits';
import { sha256Hex } from './sha256';
import type { ImportDiagnostic, ImportJobPort } from './types';

/**
 * Largest font file accepted (bytes). An engine limit, not a format one: the
 * whole file is held in memory by the page and parsed by the browser at load,
 * and 4 MiB covers a full Latin/Greek/Cyrillic family member with hinting.
 */
export const FONT_SOURCE_BYTES_MAX = 4_194_304;
/** Most tables a font's directory may list (real fonts carry about 10–30). */
export const FONT_TABLES_MAX = 128;
/** Longest family name kept (characters). */
export const FONT_FAMILY_NAME_MAX = 64;

export type FontFormat = 'ttf' | 'otf' | 'woff2' | 'woff';

/** The `font` recipe (the toolchain names this inspector). */
export interface FontRecipe {
  readonly profile: 'font';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
}

/** Facts about one font file (all re-derivable from the bytes). */
export interface FontMetrics {
  readonly format: FontFormat;
  /** The family name from an uncompressed sfnt's `name` table, when present. */
  readonly familyName?: string;
}

export interface FontImportOptions {
  readonly profile: 'font';
  readonly recipeVersion: 1;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly displayName?: string;
  readonly job?: ImportJobPort;
}

export interface FontImportProposal {
  readonly proposalId: string;
  readonly stageId: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly status: 'ok' | 'rejected';
  readonly kind?: 'font';
  readonly importRecipe: FontRecipe;
  readonly metrics?: FontMetrics;
  readonly suggestedDisplayName: string;
  /** What the header says (shown by the import panel). */
  readonly inspection: { readonly format: FontFormat | null; readonly familyName?: string };
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly diagnosticCount: number;
  readonly expiresAt: string;
}

export const FONT_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({ [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION });

function diag(code: ImportDiagnostic['code'], message: string, found?: unknown, expected?: string): ImportDiagnostic {
  return { code, path: '', message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) };
}

const ascii = (b: Uint8Array, at: number, n: number): string => (at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '');

/** The sfnt version tag of a TrueType or CFF font, or null. */
function sfntFlavor(view: DataView, at: number, b: Uint8Array): 'ttf' | 'otf' | null {
  if (at + 4 > b.length) return null;
  if (view.getUint32(at) === 0x00010000 || ascii(b, at, 4) === 'true') return 'ttf';
  if (ascii(b, at, 4) === 'OTTO') return 'otf';
  return null;
}

/** Printable characters only, bounded; empty means "no usable name". */
function cleanName(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) continue;
    out += ch;
  }
  return out.trim().slice(0, FONT_FAMILY_NAME_MAX);
}

/** The family name (typographic family 16, else family 1) from a `name` table; undefined when absent or unreadable. */
function readFamilyName(b: Uint8Array, view: DataView, offset: number, length: number): string | undefined {
  if (length < 6 || offset + length > b.length) return undefined;
  const count = view.getUint16(offset + 2);
  const strings = offset + view.getUint16(offset + 4);
  if (6 + count * 12 > length) return undefined;
  let best: { rank: number; text: string } | null = null;
  for (let i = 0; i < count; i++) {
    const r = offset + 6 + i * 12;
    const platform = view.getUint16(r);
    const encoding = view.getUint16(r + 2);
    const nameId = view.getUint16(r + 6);
    const len = view.getUint16(r + 8);
    const at = strings + view.getUint16(r + 10);
    if ((nameId !== 1 && nameId !== 16) || at + len > offset + length || at + len > b.length) continue;
    let text: string;
    if (platform === 3 || platform === 0) {
      // Windows / Unicode: UTF-16BE.
      text = '';
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(view.getUint16(at + k));
    } else if (platform === 1 && encoding === 0) {
      // Macintosh Roman: the ASCII range is enough for a label.
      text = String.fromCharCode(...b.subarray(at, at + len).filter((c) => c < 0x80));
    } else continue;
    const clean = cleanName(text);
    if (clean === '') continue;
    const rank = (nameId === 16 ? 0 : 2) + (platform === 3 ? 0 : 1);
    if (best === null || rank < best.rank) best = { rank, text: clean };
  }
  return best?.text;
}

/** TTF/OTF: the offset table and the table records, every table inside the file. */
function parseSfnt(b: Uint8Array, view: DataView, format: 'ttf' | 'otf'): FontMetrics | ImportDiagnostic {
  if (b.length < 12) return diag('asset_container_invalid', 'the font file is truncated');
  const numTables = view.getUint16(4);
  if (numTables < 1 || numTables > FONT_TABLES_MAX) return diag('asset_container_invalid', 'the font table count is out of range', numTables, `1..${FONT_TABLES_MAX}`);
  if (12 + numTables * 16 > b.length) return diag('asset_container_invalid', 'the font table directory is truncated');
  const tags = new Set<string>();
  let name: { offset: number; length: number } | null = null;
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    const tag = ascii(b, r, 4);
    const offset = view.getUint32(r + 8);
    const length = view.getUint32(r + 12);
    if (offset + length > b.length) return diag('asset_container_invalid', `the font table "${cleanName(tag)}" lies outside the file`, offset + length, `<= ${b.length}`);
    tags.add(tag);
    if (tag === 'name') name = { offset, length };
  }
  for (const required of ['cmap', 'head']) {
    if (!tags.has(required)) return diag('asset_container_invalid', `the font has no "${required}" table`, undefined, `a "${required}" table`);
  }
  const familyName = name === null ? undefined : readFamilyName(b, view, name.offset, name.length);
  return familyName !== undefined ? { format, familyName } : { format };
}

/** WOFF 1.0: the 44-byte header, its declared length and the table directory. */
function parseWoff(b: Uint8Array, view: DataView): FontMetrics | ImportDiagnostic {
  if (b.length < 44) return diag('asset_container_invalid', 'the WOFF header is truncated');
  if (sfntFlavor(view, 4, b) === null) return diag('asset_container_invalid', 'the WOFF flavor is neither TrueType nor CFF');
  if (view.getUint32(8) !== b.length) return diag('asset_container_invalid', 'the WOFF length does not match the file', view.getUint32(8), `${b.length}`);
  const numTables = view.getUint16(12);
  if (numTables < 1 || numTables > FONT_TABLES_MAX) return diag('asset_container_invalid', 'the font table count is out of range', numTables, `1..${FONT_TABLES_MAX}`);
  if (view.getUint16(14) !== 0) return diag('asset_container_invalid', 'the WOFF reserved field is not zero');
  if (44 + numTables * 20 > b.length) return diag('asset_container_invalid', 'the WOFF table directory is truncated');
  for (let i = 0; i < numTables; i++) {
    const r = 44 + i * 20;
    const offset = view.getUint32(r + 4);
    const compLength = view.getUint32(r + 8);
    const origLength = view.getUint32(r + 12);
    if (offset + compLength > b.length || compLength > origLength) return diag('asset_container_invalid', 'a WOFF table lies outside the file');
  }
  return { format: 'woff' };
}

/** WOFF2: the 48-byte header, its declared length and compressed size. */
function parseWoff2(b: Uint8Array, view: DataView): FontMetrics | ImportDiagnostic {
  if (b.length < 48) return diag('asset_container_invalid', 'the WOFF2 header is truncated');
  if (sfntFlavor(view, 4, b) === null && ascii(b, 4, 4) !== 'ttcf') return diag('asset_container_invalid', 'the WOFF2 flavor is neither TrueType nor CFF');
  if (view.getUint32(8) !== b.length) return diag('asset_container_invalid', 'the WOFF2 length does not match the file', view.getUint32(8), `${b.length}`);
  const numTables = view.getUint16(12);
  if (numTables < 1 || numTables > FONT_TABLES_MAX) return diag('asset_container_invalid', 'the font table count is out of range', numTables, `1..${FONT_TABLES_MAX}`);
  if (view.getUint16(14) !== 0) return diag('asset_container_invalid', 'the WOFF2 reserved field is not zero');
  // Each directory entry is at least 2 bytes; the compressed stream follows it.
  if (48 + numTables * 2 + view.getUint32(20) > b.length) return diag('asset_container_invalid', 'the WOFF2 compressed data is truncated');
  return { format: 'woff2' };
}

function inspectStages(bytes: Uint8Array): FontMetrics | ImportDiagnostic[] {
  if (bytes.length > FONT_SOURCE_BYTES_MAX) {
    return [diag('asset_size_exceeded', 'the font file is too large', bytes.length, `<= ${FONT_SOURCE_BYTES_MAX} bytes`)];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = sfntFlavor(view, 0, bytes);
  let parsed: FontMetrics | ImportDiagnostic;
  if (flavor !== null) parsed = parseSfnt(bytes, view, flavor);
  else if (ascii(bytes, 0, 4) === 'wOFF') parsed = parseWoff(bytes, view);
  else if (ascii(bytes, 0, 4) === 'wOF2') parsed = parseWoff2(bytes, view);
  else return [diag('asset_container_invalid', 'not a TrueType, OpenType, WOFF2 or WOFF font', undefined, 'TTF, OTF, WOFF2 or WOFF')];
  return 'code' in parsed ? [parsed] : parsed;
}

/** Bounded font inspection; malformed bytes give a `rejected` proposal, never an exception. */
export function inspectFont(bytes: Uint8Array, options: FontImportOptions): FontImportProposal {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inspectFont: bytes must be a Uint8Array');
  if (options.profile !== 'font' || options.recipeVersion !== 1) throw new TypeError("inspectFont: expected profile 'font', recipeVersion 1");
  const recipe: FontRecipe = { profile: 'font', recipeVersion: 1, toolchain: { ...FONT_TOOLCHAIN } };
  const sourceDigest = sha256Hex(bytes);
  const job = resolveImportJob(options.job, options, sourceDigest);
  let result: FontMetrics | ImportDiagnostic[];
  try {
    result = inspectStages(bytes);
  } catch {
    result = [diag('asset_container_invalid', 'the font file is malformed')];
  }
  const base = {
    proposalId: job.proposalId,
    stageId: job.stageId,
    sourceDigest,
    sourceByteLength: bytes.length,
    importRecipe: recipe,
    suggestedDisplayName: job.suggestedDisplayName,
    expiresAt: job.expiresAt,
  };
  if (Array.isArray(result)) {
    return Object.freeze({ ...base, status: 'rejected' as const, inspection: { format: null }, diagnostics: result.slice(0, M2_GLTF_MAX_DIAGNOSTICS), diagnosticCount: result.length });
  }
  const inspection = result.familyName !== undefined ? { format: result.format, familyName: result.familyName } : { format: result.format };
  return Object.freeze({ ...base, status: 'ok' as const, kind: 'font' as const, metrics: result, inspection, diagnostics: [], diagnosticCount: 0 });
}
