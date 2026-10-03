/**
 * Play diagnostics travel from the game page through the editor and the
 * backend to an MCP client inside one bound. A long run's diagnostics can
 * outgrow it (the play log above all); rather than refuse the whole report,
 * the page trims it to fit and says what it left out, so the logs of exactly
 * the long runs that need reading still arrive.
 */

/** The largest Play diagnostics payload (its JSON text, UTF-8 bytes). */
export const PLAY_DIAGNOSTICS_MAX_BYTES = 16_384;

/** What `fitPlayDiagnostics` left out to fit the bound. */
export interface PlayDiagnosticsTrim {
  /** Play log entries dropped, oldest first (`runtime.errors`). */
  readonly logEntries: number;
  /** Entries dropped from other lists, oldest (first) first, by path. */
  readonly lists: Readonly<Record<string, number>>;
  /** Whole parts left out, largest first, when trimming lists was not enough. */
  readonly omitted: readonly string[];
}

const encoder = new TextEncoder();
/** A value's JSON text in UTF-8 bytes: what `PLAY_DIAGNOSTICS_MAX_BYTES` bounds (non-ASCII log text is several bytes a character). */
export const playDiagnosticsBytes = (v: unknown): number => encoder.encode(JSON.stringify(v)).length;
const bytesOf = playDiagnosticsBytes;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Room kept for the `trimmed` note itself. */
const NOTE_ROOM = 512;

/** Every list in the value (to a small depth), with its path. */
function listsOf(v: Record<string, unknown>, path: string, depth: number, out: { path: string; list: unknown[] }[]): void {
  for (const [k, x] of Object.entries(v)) {
    const p = path === '' ? k : `${path}.${k}`;
    if (Array.isArray(x)) out.push({ path: p, list: x });
    else if (isObj(x) && depth < 4) listsOf(x, p, depth + 1, out);
  }
}

/**
 * The diagnostics as they are when they fit `maxBytes`; else a copy that
 * fits, with a `trimmed` note: the play log (`runtime.errors`) loses its
 * oldest entries first; then the other lists lose their oldest entries,
 * longest list first; then whole parts are left out, largest first.
 */
export function fitPlayDiagnostics(diagnostics: Record<string, unknown>, maxBytes: number = PLAY_DIAGNOSTICS_MAX_BYTES): Record<string, unknown> {
  if (bytesOf(diagnostics) <= maxBytes) return diagnostics;
  const d = JSON.parse(JSON.stringify(diagnostics)) as Record<string, unknown>;
  const budget = Math.max(0, maxBytes - NOTE_ROOM);
  let logEntries = 0;
  const lists: Record<string, number> = {};
  const omitted: string[] = [];
  const runtime = d['runtime'];
  const log = isObj(runtime) && Array.isArray(runtime['errors']) ? (runtime['errors'] as unknown[]) : null;
  while (log !== null && log.length > 0 && bytesOf(d) > budget) {
    log.shift();
    logEntries += 1;
  }
  if (bytesOf(d) > budget) {
    const found: { path: string; list: unknown[] }[] = [];
    listsOf(d, '', 0, found);
    const others = found.filter((f) => f.list !== log && f.list.length > 0).sort((a, b) => bytesOf(b.list) - bytesOf(a.list));
    for (const f of others) {
      while (f.list.length > 0 && bytesOf(d) > budget) {
        // Half of what is left at a time (a list of thousands is cut in a few passes).
        const n = Math.max(1, Math.floor(f.list.length / 2));
        f.list.splice(0, n);
        lists[f.path] = (lists[f.path] ?? 0) + n;
      }
      if (bytesOf(d) <= budget) break;
    }
  }
  if (bytesOf(d) > budget) {
    const parts = Object.keys(d).sort((a, b) => bytesOf(d[b]) - bytesOf(d[a]));
    for (const k of parts) {
      if (bytesOf(d) <= budget) break;
      delete d[k];
      omitted.push(k);
    }
  }
  const trimmed: PlayDiagnosticsTrim = { logEntries, lists, omitted };
  return { ...d, trimmed };
}
