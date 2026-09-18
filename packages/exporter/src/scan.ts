/**
 * Forbidden-content scan (export.md §5.4 — normative patterns a–j) over
 * every emitted byte of the four output files, with the §5.4.1
 * recorded-exception table for the pinned `three@0.186.0`.
 *
 * The patterns are absolute for ENGINE CODE. The pinned three carries inert
 * occurrences of four patterns (d `fetch(`, f `process.`, h URL literals,
 * j `XMLHttpRequest`) inside its own shipped code; the contract records them
 * as a version-bound exception with EXACT counts, applied only when all
 * binding conditions hold:
 *   1. Identity — the bundled three is exactly 0.186.0 (package version +
 *      the lockfile registry integrity equal to the recorded sha512).
 *   2. Flags — the build used exactly the export.md §5.3 pinned option set
 *      (enforced by the exporter's build call, not re-checkable here).
 *   3. Reference build — a reference full-core three bundle (the entry
 *      `import * as THREE from 'three';`, same pinned options) re-scans to
 *      exactly the table's counts (re-verifies the record against the
 *      current install before the real bundle is judged).
 *   4. Real-bundle exact counts — as recorded below.
 * Any hit outside the binding conditions is a failure, not an exception
 * (export.md §5.4.1 "No silent exceptions").
 *
 * Pure string/byte processing: no I/O (the bytes are passed in).
 */

/** The §5.4.1 recorded-exception table (pinned three@0.186.0, pinned flags). */
export const THREE_RECORD = {
  version: '0.186.0',
  /** dependencies.md §7 / export.md §5.4.1: npm registry integrity of three@0.186.0. */
  integrity: 'sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==',
  /** d — `fetch(` in the pinned three code (two loader fetches + one warn literal). */
  fetch: 3,
  /** f — `process.` (two warn literals + one doc comment); `__dirname`: 0. */
  processDot: 3,
  /** h — `http://` (XHTML namespace + two doc comments). */
  http: 3,
  /** h — `https://` (23 doc-comment reference links). */
  https: 23,
  /** h — `file://`: absent. */
  file: 0,
  /** j — `XMLHttpRequest` (three doc comments); `WebSocket`: 0. */
  xhr: 3,
  ws: 0,
} as const;

/** The export bundle's single engine-initiated fetch (export.md §5.3). */
const SNAPSHOT_FETCH_LITERAL = 'fetch("./snapshot.json")';

export interface ScanFile {
  name: string;
  bytes: Uint8Array;
}

/** One reported hit (export.md §4.1 step 5: ≤ 4 reported). */
export interface ScanHit {
  pattern: string;
  byteOffset: number;
  /** ≤ 80 chars of context around the hit. */
  context: string;
}

export interface ScanPatterns {
  /** a — the configured authoring origin (sessions.md §13.7). */
  authoringOrigin: string;
  /** b — the configured preview origin. */
  previewOrigin: string;
  /** i — the configured admin/authoring token VALUES (no secrets in the output). */
  tokenValues: readonly string[];
}

export interface ScanReport {
  ok: boolean;
  /** Hits OUTSIDE the recorded-exception scope (must be 0 for a success). */
  scanHits: number;
  /** First ≤ 4 out-of-scope hits (bounded, export.md §4.1). */
  hits: ScanHit[];
  /** The §5.4.1 binding conditions (identity + reference check). */
  binding: { identityOk: boolean; referenceOk: boolean; reason?: string };
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

/** The byte offset of the k-th occurrence (0-based) of `needle`. */
function kthOffset(haystack: string, needle: string, k: number): number {
  let idx = haystack.indexOf(needle);
  for (let i = 0; i < k && idx !== -1; i += 1) {
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return idx;
}

function contextAround(haystack: string, offset: number): string {
  const start = Math.max(0, offset - 30);
  const end = Math.min(haystack.length, offset + 50);
  return haystack.slice(start, end).replace(/[^\x20-\x7e]/g, '.').slice(0, 80);
}

/**
 * Scan one file against a list of (pattern, expectedCount) pairs.
 * `expectedCount` -1 means "at most 0" is NOT the semantics — pass exact
 * expectations; the caller computes which counts are failures. Returns the
 * per-pattern counts and the first out-of-scope hit positions.
 */
function patternCounts(haystack: string, patterns: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of patterns) m.set(p, countOccurrences(haystack, p));
  return m;
}

/**
 * Run the §5.4 scan over the four emitted files.
 *
 * @param files the emitted output files (index.html, js/main.js, snapshot.json, meta.json)
 * @param p the configured scan patterns (origins, token values)
 * @param bundleName the bundle file name (`js/main.js`)
 * @param threeIdentity binding 1: the installed three's version + integrity
 * @param referenceBytes binding 3: the reference full-core three bundle bytes
 *        (null ⇒ the reference check was not run ⇒ the binding fails closed)
 */
export function scanExportFiles(
  files: ScanFile[],
  p: ScanPatterns,
  bundleName: string,
  threeIdentity: { version: string; integrity: string | null },
  referenceBytes: Uint8Array | null,
): ScanReport {
  // Binding 1 — identity (exact version + recorded registry integrity).
  const identityOk =
    threeIdentity.version === THREE_RECORD.version && threeIdentity.integrity === THREE_RECORD.integrity;

  // Binding 3 — the reference build re-scans to exactly the table's counts.
  let referenceOk = false;
  let reason: string | undefined;
  if (referenceBytes !== null) {
    const ref = new TextDecoder().decode(referenceBytes);
    const expected: Array<[string, number]> = [
      ['fetch(', THREE_RECORD.fetch],
      ['process.', THREE_RECORD.processDot],
      ['__dirname', 0],
      ['http://', THREE_RECORD.http],
      ['https://', THREE_RECORD.https],
      ['file://', THREE_RECORD.file],
      ['XMLHttpRequest', THREE_RECORD.xhr],
      ['WebSocket', THREE_RECORD.ws],
      ['/api/v1/', 0],
      ['node:', 0],
      ['/mcp', 0],
      ...tokenPatterns(p).map((t): [string, number] => [t, 0]),
      ...originPatterns(p).map((t): [string, number] => [t, 0]),
    ];
    const mismatch = expected.find(([needle, want]) => countOccurrences(ref, needle) !== want);
    if (mismatch === undefined) {
      referenceOk = true;
    } else {
      referenceOk = false;
      reason = `reference three bundle scan deviates: '${mismatch[0]}' expected ${mismatch[1]}, found ${countOccurrences(ref, mismatch[0])}`;
    }
  } else {
    reason = 'reference three build was not produced';
  }

  const exceptionsApply = identityOk && referenceOk;

  const scanHits: ScanHit[] = [];
  let totalHits = 0;

  const record = (pattern: string, offset: number, text: string): void => {
    totalHits += 1;
    if (scanHits.length < 4) {
      scanHits.push({ pattern, byteOffset: offset, context: contextAround(text, offset) });
    }
  };

  for (const f of files) {
    const text = new TextDecoder().decode(f.bytes);
    const isBundle = f.name === bundleName;

    // Absolute (strict) patterns — 0 hits everywhere, including the bundle
    // (a/b/c/e/g/i and the non-exception parts of f/h/j). One report per
    // pattern (the first hit) keeps the ≤ 4 hit budget meaningful.
    for (const needle of [p.authoringOrigin, p.previewOrigin, '/api/v1/', 'node:', '/mcp', 'WebSocket', '__dirname', ...p.tokenValues]) {
      if (needle.length === 0) continue;
      if (countOccurrences(text, needle) > 0) record(needle, kthOffset(text, needle, 0), text);
    }

    if (!isBundle) {
      // Non-bundle files: every pattern is strict-0.
      for (const needle of ['fetch(', 'process.', 'http://', 'https://', 'file://', 'XMLHttpRequest']) {
        if (countOccurrences(text, needle) > 0) record(needle, kthOffset(text, needle, 0), text);
      }
      continue;
    }

    // The bundle file.
    if (exceptionsApply) {
      // Binding 4 — exact counts for the exception patterns. A deviation is
      // reported once: the first EXCESS occurrence (or a sentinel hit when
      // the count is short).
      const checks: Array<[string, number]> = [
        ['process.', THREE_RECORD.processDot],
        ['http://', THREE_RECORD.http],
        ['https://', THREE_RECORD.https],
        ['file://', THREE_RECORD.file],
        ['XMLHttpRequest', THREE_RECORD.xhr],
      ];
      for (const [needle, want] of checks) {
        const n = countOccurrences(text, needle);
        if (n !== want) record(needle, n > want ? kthOffset(text, needle, want) : -1, text);
      }
      // d — exactly 3 (three's) + the engine's one snapshot fetch.
      const fetchN = countOccurrences(text, 'fetch(');
      const literalN = countOccurrences(text, SNAPSHOT_FETCH_LITERAL);
      if (literalN !== 1) record(SNAPSHOT_FETCH_LITERAL, literalN > 0 ? kthOffset(text, SNAPSHOT_FETCH_LITERAL, 0) : -1, text);
      if (fetchN !== THREE_RECORD.fetch + 1) {
        record('fetch(', fetchN > THREE_RECORD.fetch + 1 ? kthOffset(text, 'fetch(', THREE_RECORD.fetch + 1) : -1, text);
      }
    } else {
      // Binding failed closed: the unmodified (strict) scan applies — any
      // occurrence of an exception pattern is a failure (one report each).
      for (const needle of ['fetch(', 'process.', 'http://', 'https://', 'file://', 'XMLHttpRequest']) {
        if (countOccurrences(text, needle) > 0) record(needle, kthOffset(text, needle, 0), text);
      }
    }
  }

  return {
    ok: totalHits === 0,
    scanHits: totalHits,
    hits: scanHits,
    binding: { identityOk, referenceOk, reason },
  };
}

function tokenPatterns(p: ScanPatterns): string[] {
  return p.tokenValues.filter((t) => t.length > 0);
}

function originPatterns(p: ScanPatterns): string[] {
  return [p.authoringOrigin, p.previewOrigin].filter((s) => s.length > 0);
}