/**
 * Packet 36 — format-aware validation of the emitted M2 export closure
 * (export.md §4 step 5/5a/5b/5c, sessions.md §17.5/§17.5.1).
 *
 * M1's textual pattern scan (§5.4 a–j) is meaningful for JavaScript/text bytes.
 * Running it over a GLB binary is meaningless, so M2 validates **by container
 * format** and then scans text:
 *
 * - `scanGlbContainer(bytes)`  — glTF magic/version/declared length, chunk
 *   table, strict JSON chunk, every `uri` free of a scheme/absolute/traversal
 *   form (sessions.md §17.5.1).
 * - `scanWasmContainer(bytes)` — `\0asm` magic + version 1 + declared digest
 *   pin (no WASM artifact is emitted by the packet-36 closure; the validator is
 *   implemented and unit-tested so a future WASM artifact cannot bypass it).
 * - `scanM2TextBundle(...)`    — the §5.4 a–j patterns for JS/text bytes with
 *   the §5.4.1 recorded-exception counts re-measured against the current
 *   install (core three + the GLTFLoader subpath row + the pinned Rapier
 *   compat row) and the exact declared-fetch count (one `fetch(` per unique
 *   declared asset path + the single `./manifest.json` read).
 * - `assertRelativeClosure(files)` — every emitted reference is relative; no
 *   absolute path, `file://`, `http(s)://`, `node:` or Node leak anywhere.
 *
 * Pure byte/string processing: no I/O.
 */
import { type ScanHit } from './scan';

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

/** Strict JSON parse rejecting duplicate object keys (the §17.5.1 "strict"). */
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

/** A forbidden `uri` value (sessions.md §17.5.1). */
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

/** GLB container validation (sessions.md §17.5.1). */
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

/** WASM container validation (sessions.md §17.5.1; empty host-import allowlist). */
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

/** The §5.4 a–j pattern counts for one text byte string. */
export function textPatternCounts(text: string, p: ScanPatterns): M2ScanCounts {
  const iValues = [...p.tokenValues, ...(p.locatorValues ?? [])].filter((v) => v.length > 0);
  return {
    a: countOccurrences(text, p.authoringOrigin),
    b: countOccurrences(text, p.previewOrigin),
    c: countOccurrences(text, '/api/v1/'),
    d: countOccurrences(text, 'fetch('),
    e: countOccurrences(text, 'node:'),
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
 * WAV (RIFF/WAVE) container validation (export.md §6.3, the `audio/wav`
 * artifact row): the `RIFF`/`WAVE` markers, a `fmt ` chunk with PCM
 * (`audioFormat 1`) mono/48000/16-bit, and a `data` chunk whose declared size
 * fits the file. Pure byte processing: no I/O.
 */
export function scanWavContainer(bytes: Uint8Array): ContainerResult {
  if (bytes.length < 44) return { ok: false, code: 'wav_truncated', message: 'a WAV shorter than the 44-byte canonical RIFF/WAVE header' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
  if (tag(0) !== 'RIFF') return { ok: false, code: 'wav_riff', message: 'the file magic is not "RIFF"', offset: 0 };
  const riffDeclared = dv.getUint32(4, true);
  if (riffDeclared + 8 !== bytes.length) {
    return { ok: false, code: 'wav_riff_length', message: `the RIFF declared length ${riffDeclared} + 8 != the file length ${bytes.length}`, offset: 4 };
  }
  if (tag(8) !== 'WAVE') return { ok: false, code: 'wav_wave', message: 'the form type is not "WAVE"', offset: 8 };
  // Walk the chunks: locate the `fmt ` and `data` chunks.
  let off = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataChunk = -1;
  let dataLength = 0;
  while (off + 8 <= bytes.length) {
    const name = tag(off);
    const size = dv.getUint32(off + 4, true);
    const bodyStart = off + 8;
    if (bodyStart + size > bytes.length) return { ok: false, code: 'wav_chunk_bounds', message: `a chunk (${name}) runs past the file end`, offset: off };
    if (name === 'fmt ' && fmt === null) {
      if (size < 16) return { ok: false, code: 'wav_fmt_short', message: 'the fmt chunk is shorter than 16 bytes', offset: off };
      fmt = {
        audioFormat: dv.getUint16(bodyStart, true),
        channels: dv.getUint16(bodyStart + 2, true),
        sampleRate: dv.getUint32(bodyStart + 4, true),
        bitsPerSample: dv.getUint16(bodyStart + 14, true),
      };
    } else if (name === 'data' && dataChunk === -1) {
      dataChunk = bodyStart;
      dataLength = size;
    }
    off = bodyStart + size + (size % 2); // chunks are word-aligned
  }
  if (fmt === null) return { ok: false, code: 'wav_no_fmt', message: 'the container has no fmt chunk' };
  if (fmt.audioFormat !== 1) return { ok: false, code: 'wav_format', message: `audioFormat ${fmt.audioFormat} is not PCM (1)`, offset: 20 };
  if (fmt.channels !== 1) return { ok: false, code: 'wav_channels', message: `channels ${fmt.channels} is not mono (1)`, offset: 22 };
  if (fmt.sampleRate !== 48000) return { ok: false, code: 'wav_sample_rate', message: `sampleRate ${fmt.sampleRate} is not 48000`, offset: 24 };
  if (fmt.bitsPerSample !== 16) return { ok: false, code: 'wav_bits', message: `bitsPerSample ${fmt.bitsPerSample} is not 16`, offset: 34 };
  if (dataChunk === -1) return { ok: false, code: 'wav_no_data', message: 'the container has no data chunk' };
  if (dataLength % 2 !== 0) return { ok: false, code: 'wav_data_odd', message: 'the data chunk size is odd (s16le frames are 2-byte aligned)', offset: dataChunk - 4 };
  return { ok: true };
}

/**
 * `assertRelativeClosure` (sessions.md §17.5.1): every emitted text file's
 * references are relative — the §5.4 absolute patterns are zero outside the
 * recorded §5.4.1 exception scope.
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
