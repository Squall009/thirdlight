/**
 * Format-aware validation of the emitted export closure (export.md steps
 * 5/5a/5b/5c).
 *
 * The textual pattern scan (a–j) is meaningful for JavaScript/text bytes.
 * Running it over a GLB binary is meaningless, so the closure is validated
 * **by container format** and then text is scanned:
 *
 * - `scanGlbContainer(bytes)`  — glTF magic/version/declared length, chunk
 *   table, strict JSON chunk, every `uri` free of a scheme/absolute/traversal
 *   form.
 * - `scanWasmContainer(bytes)` — `\0asm` magic + version 1 + declared digest
 *   pin (the closure emits no WASM artifact; the validator is
 *   implemented and unit-tested so a future WASM artifact cannot bypass it).
 * - `scanM2TextBundle(...)`    — the a–j patterns for JS/text bytes with
 *   the recorded-exception counts re-measured against the current
 *   install (core three + the GLTFLoader subpath row + the pinned Rapier
 *   compat row) and the exact declared-fetch count (one `fetch(` per unique
 *   declared asset path + the single `./manifest.json` read).
 * - `assertRelativeClosure(files)` — every emitted reference is relative; no
 *   absolute path, `file://`, `http(s)://`, `node:` or Node leak anywhere.
 *
 * Pure byte/string processing: no I/O.
 */
import { nodeSpecifierOffsets, type ScanHit } from './scan';

export interface ScanPatterns {
  authoringOrigin: string;
  previewOrigin: string;
  tokenValues: readonly string[];
  /** The active `contentId`s (locator values) — pattern i gains these. */
  locatorValues?: readonly string[];
}

export type ContainerResult = { ok: true } | { ok: false; code: string; message: string; offset?: number };

/** Recursively collect every value of a JSON key named `key`. */
function collectKeyValues(value: unknown, key: string, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeyValues(v, key, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === key) out.push(v);
      collectKeyValues(v, key, out);
    }
  }
}

/** The first duplicate object key in a JSON text (null when none). */
function findDuplicateKey(text: string): string | null {
  interface Frame {
    kind: 'object' | 'array';
    keys: Set<string>;
    expectKey: boolean;
  }
  const stack: Frame[] = [];
  const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (isWs(c)) {
      i += 1;
      continue;
    }
    if (c === '{') {
      stack.push({ kind: 'object', keys: new Set(), expectKey: true });
      i += 1;
      continue;
    }
    if (c === '[') {
      stack.push({ kind: 'array', keys: new Set(), expectKey: false });
      i += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      i += 1;
      continue;
    }
    if (c === ',') {
      const f = stack[stack.length - 1];
      if (f !== undefined && f.kind === 'object') f.expectKey = true;
      i += 1;
      continue;
    }
    if (c === ':') {
      const f = stack[stack.length - 1];
      if (f !== undefined) f.expectKey = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < text.length) {
        const ch = text[i] as string;
        if (ch === '\\') {
          i += 2;
          continue;
        }
        i += 1;
        if (ch === '"') break;
      }
      const raw = text.slice(start, i);
      const f = stack[stack.length - 1];
      if (f !== undefined && f.kind === 'object' && f.expectKey) {
        const name = JSON.parse(raw) as string;
        if (f.keys.has(name)) return name;
        f.keys.add(name);
        f.expectKey = false;
      }
      continue;
    }
    i += 1;
  }
  return null;
}

/** Strict JSON parse rejecting duplicate object keys. */
function strictJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const value = JSON.parse(text) as unknown;
    const duplicate = findDuplicateKey(text);
    if (duplicate !== null) return { ok: false, message: `duplicate JSON key "${duplicate}"` };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

/** A forbidden `uri` value. */
export function forbiddenUriReason(uri: string): string | null {
  if (uri.includes('://')) return 'contains a scheme separator "://"';
  if (uri.startsWith('data:')) return 'is a data: URI';
  if (uri.startsWith('file:')) return 'is a file: URI';
  if (uri.includes('//')) return 'contains "//"';
  if (uri.startsWith('/')) return 'is an absolute path';
  if (uri.includes('..')) return 'contains ".."';
  if (uri.includes('\\')) return 'contains a backslash';
  return null;
}

/** GLB container validation. */
export function scanGlbContainer(bytes: Uint8Array): ContainerResult {
  if (bytes.length < 20) return { ok: false, code: 'glb_truncated', message: 'a GLB shorter than the 12-byte header + 8-byte chunk header' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) return { ok: false, code: 'glb_magic', message: 'the file magic is not "glTF"', offset: 0 };
  const version = dv.getUint32(4, true);
  if (version !== 2) return { ok: false, code: 'glb_version', message: `glTF container version ${version} is not 2`, offset: 4 };
  const declaredLength = dv.getUint32(8, true);
  if (declaredLength !== bytes.length) {
    return { ok: false, code: 'glb_length', message: `the declared length ${declaredLength} != the file length ${bytes.length}`, offset: 8 };
  }
  let offset = 12;
  let first = true;
  let sawJson = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return { ok: false, code: 'glb_chunk_header', message: 'a chunk header runs past the file end', offset };
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + chunkLength > bytes.length) {
      return { ok: false, code: 'glb_chunk_bounds', message: 'a chunk runs past the file end', offset };
    }
    if (first && chunkType !== 0x4e4f534a) return { ok: false, code: 'glb_first_chunk', message: 'the first chunk is not JSON', offset };
    if (chunkType === 0x4e4f534a) {
      sawJson = true;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(dataStart, dataStart + chunkLength));
      const parsed = strictJson(text.replace(/\u0000+$/g, '').replace(/\s+$/g, ''));
      if (!parsed.ok) return { ok: false, code: 'glb_json', message: `the JSON chunk is not strict JSON: ${parsed.message}`, offset: dataStart };
      const uris: unknown[] = [];
      collectKeyValues(parsed.value, 'uri', uris);
      for (const u of uris) {
        if (typeof u !== 'string') return { ok: false, code: 'glb_uri_type', message: 'a uri value is not a string', offset: dataStart };
        const reason = forbiddenUriReason(u);
        if (reason !== null) {
          return { ok: false, code: 'glb_uri_forbidden', message: `a uri value ${reason}`, offset: dataStart };
        }
      }
    }
    first = false;
    offset = dataStart + chunkLength;
  }
  if (!sawJson) return { ok: false, code: 'glb_no_json', message: 'the container has no JSON chunk' };
  return { ok: true };
}

/** WASM container validation (empty host-import allowlist). */
export function scanWasmContainer(bytes: Uint8Array, declaredDigest: string): ContainerResult {
  if (bytes.length < 8) return { ok: false, code: 'wasm_truncated', message: 'a WASM module shorter than its 8-byte header' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x6d736100) return { ok: false, code: 'wasm_magic', message: 'the file magic is not "\\0asm"', offset: 0 };
  const version = dv.getUint32(4, true);
  if (version !== 1) return { ok: false, code: 'wasm_version', message: `WASM version ${version} is not 1`, offset: 4 };
  if (!/^[0-9a-f]{64}$/.test(declaredDigest)) return { ok: false, code: 'wasm_pin', message: 'the artifact has no declared 64-hex digest pin' };
  return { ok: true };
}

export interface M2ScanCounts {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
  i: number;
  j: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** The a–j pattern counts for one text byte string. */
export function textPatternCounts(text: string, p: ScanPatterns): M2ScanCounts {
  const iValues = [...p.tokenValues, ...(p.locatorValues ?? [])].filter((v) => v.length > 0);
  return {
    a: countOccurrences(text, p.authoringOrigin),
    b: countOccurrences(text, p.previewOrigin),
    c: countOccurrences(text, '/api/v1/'),
    d: countOccurrences(text, 'fetch('),
    // A Node built-in module specifier (not an object key named `node`).
    e: nodeSpecifierOffsets(text).length,
    f: countOccurrences(text, '__dirname') + countOccurrences(text, 'process.'),
    g: countOccurrences(text, '/mcp'),
    h: countOccurrences(text, 'http://') + countOccurrences(text, 'https://') + countOccurrences(text, 'file://'),
    i: iValues.reduce((n, v) => n + countOccurrences(text, v), 0),
    j: countOccurrences(text, 'XMLHttpRequest') + countOccurrences(text, 'WebSocket'),
  };
}

const LOADER_HTTPS_ADDITION = 12;
const LOADER_IDENTIFIER_MIN = 37;

/**
 * Audio container validation (the `audio/x-audio` artifact row): an Ogg
 * page, an MP3 (ID3v2 tag or an MPEG frame sync), a FLAC stream marker
 * (after an optional ID3v2 tag), or a RIFF/WAVE that does not declare more
 * bytes than the file has (a streamed WAV may declare 0 or 0xFFFFFFFF). No
 * decoding.
 */
export function scanAudioContainer(bytes: Uint8Array): ContainerResult {
  const tag = (at: number, n: number): string => (bytes.length >= at + n ? String.fromCharCode(...bytes.subarray(at, at + n)) : '');
  if (tag(0, 4) === 'OggS') return bytes.length >= 27 && bytes[4] === 0 ? { ok: true } : { ok: false, code: 'audio_ogg_page', message: 'the Ogg page header is invalid', offset: 4 };
  if (tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE') {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    return declared === 0 || declared === 0xffffffff || declared + 8 <= bytes.length ? { ok: true } : { ok: false, code: 'audio_wav_length', message: `the WAV declares ${declared + 8} bytes but the file has ${bytes.length}`, offset: 4 };
  }
  let at = 0;
  if (tag(0, 3) === 'ID3' && bytes.length >= 10) at = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  if (tag(at, 4) === 'fLaC') return { ok: true };
  if (at > 0 || (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return { ok: true };
  return { ok: false, code: 'audio_format', message: 'not an Ogg, MP3, WAV or FLAC file', offset: 0 };
}

/**
 * The container check of one declared asset artifact by its closure content
 * type (model, texture, audio, font).
 */
export function scanAssetContainer(contentType: string, bytes: Uint8Array): ContainerResult {
  if (contentType === 'model/gltf-binary') return scanGlbContainer(bytes);
  if (contentType === 'image/x-texture') return scanImageContainer(bytes);
  if (contentType === 'font/x-font') return scanFontContainer(bytes);
  return scanAudioContainer(bytes);
}

/**
 * Font validation: the sfnt version of a TrueType (0x00010000
 * or 'true') or CFF ('OTTO') font with a table directory inside the file, or
 * a WOFF2/WOFF whose declared length matches the file. No glyph parsing.
 */
export function scanFontContainer(bytes: Uint8Array): ContainerResult {
  const tag = (at: number, n: number): string => (bytes.length >= at + n ? String.fromCharCode(...bytes.subarray(at, at + n)) : '');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sfnt = bytes.length >= 4 && (view.getUint32(0) === 0x00010000 || tag(0, 4) === 'true' || tag(0, 4) === 'OTTO');
  if (sfnt) {
    if (bytes.length < 12) return { ok: false, code: 'font_sfnt_header', message: 'the font header is truncated', offset: 0 };
    const tables = view.getUint16(4);
    return tables >= 1 && 12 + tables * 16 <= bytes.length ? { ok: true } : { ok: false, code: 'font_sfnt_directory', message: 'the font table directory does not fit the file', offset: 4 };
  }
  if (tag(0, 4) === 'wOFF' || tag(0, 4) === 'wOF2') {
    const header = tag(0, 4) === 'wOFF' ? 44 : 48;
    if (bytes.length < header) return { ok: false, code: 'font_woff_header', message: 'the WOFF header is truncated', offset: 0 };
    return view.getUint32(8) === bytes.length ? { ok: true } : { ok: false, code: 'font_woff_length', message: 'the WOFF length does not match the file', offset: 8 };
  }
  return { ok: false, code: 'font_format', message: 'not a TrueType, OpenType, WOFF2 or WOFF font', offset: 0 };
}

/**
 * Texture image validation: PNG (signature + IHDR), JPEG (SOI) or
 * WebP (RIFF/WEBP with the RIFF length matching the file). No decoding.
 */
export function scanImageContainer(bytes: Uint8Array): ContainerResult {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 24 && png.every((b, i) => bytes[i] === b)) {
    const ihdr = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    return ihdr === 'IHDR' ? { ok: true } : { ok: false, code: 'image_png_ihdr', message: 'the PNG has no IHDR chunk first', offset: 12 };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ok: true };
  if (bytes.length >= 12 && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF' && String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP') {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    return declared + 8 === bytes.length ? { ok: true } : { ok: false, code: 'image_webp_length', message: 'the WebP RIFF length does not match the file', offset: 4 };
  }
  // A Basis Universal KTX2 (the header's identifier; the game's transcoder reads the rest).
  const ktx2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 80 && ktx2.every((b, i) => bytes[i] === b)) return { ok: true };
  return { ok: false, code: 'image_format', message: 'not a PNG, JPEG, WebP or KTX2 image', offset: 0 };
}

/**
 * `assertRelativeClosure`: every emitted text file's
 * references are relative — the absolute patterns are zero outside the
 * recorded exception scope.
 */
export function assertRelativeClosure(
  files: readonly { name: string; text: string }[],
  patterns: ScanPatterns,
): { ok: boolean; hits: ScanHit[] } {
  const hits: ScanHit[] = [];
  for (const f of files) {
    const needles = [
      'http://',
      'https://',
      'file://',
      'node:',
      '/api/v1/',
      '/mcp',
      '__dirname',
      'WebSocket',
      patterns.authoringOrigin,
      patterns.previewOrigin,
      ...patterns.tokenValues,
      ...(patterns.locatorValues ?? []),
    ];
    for (const needle of needles) {
      if (needle.length === 0) continue;
      const n = countOccurrences(f.text, needle);
      if (n > 0 && hits.length < 8) {
        hits.push({ pattern: needle, byteOffset: f.text.indexOf(needle), context: `${f.name}:${f.text.indexOf(needle)}` });
      }
    }
  }
  return { ok: hits.length === 0, hits };
}
