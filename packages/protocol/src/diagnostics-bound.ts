/**
 * Play diagnostics and game observations travel from the game page through
 * the editor and the backend to an MCP client inside one bound each. A big
 * scene's answer can outgrow it (many effects, textures, debug commands, a
 * long play log); rather than refuse the whole answer, the page trims it to
 * fit and says what it left out. What a test needs first from a run is its
 * errors, so those go last: copies of one row are folded first, then the
 * other lists lose their oldest rows, then the play log its oldest log
 * lines, then whole parts are left out, and only then the oldest errors.
 */
import { isErrorRow, mergeRepeatedRows } from '@thirdlight/project-model/repeated-rows';
import { GAME_OBSERVATION_MAX_BYTES } from './m3';

/** The largest Play diagnostics payload (its JSON text, UTF-8 bytes). */
export const PLAY_DIAGNOSTICS_MAX_BYTES = 16_384;

/** What a bounded Play answer left out to fit (its `trimmed` note). */
export interface PlayDiagnosticsTrim {
  /** Play log entries (`runtime.errors`) dropped, oldest first: log lines, then errors when nothing else was left. */
  readonly logEntries: number;
  /** Of `logEntries`, how many were errors (0 unless every other part was already cut). */
  readonly errorEntries: number;
  /** Rows dropped from the other lists, oldest (first) first, by path. */
  readonly lists: Readonly<Record<string, number>>;
  /** Whole parts left out, largest first, when trimming lists was not enough (a path; `runtime.x` for the play log's own part). */
  readonly omitted: readonly string[];
  /** Copies folded into one row with a `count`, by list path (rows saved). */
  readonly merged: Readonly<Record<string, number>>;
}

const encoder = new TextEncoder();
/** A value's JSON text in UTF-8 bytes: what the Play answer bounds measure (non-ASCII text is several bytes a character). */
export const playDiagnosticsBytes = (v: unknown): number => encoder.encode(JSON.stringify(v)).length;
const bytesOf = playDiagnosticsBytes;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Room kept for the `trimmed` note itself (more is taken when a long note needs it). */
const NOTE_ROOM = 512;

/** How one kind of answer is trimmed. */
interface FitPlan {
  /** Top-level parts never left out (the answer's identity and state). */
  readonly keep: readonly string[];
  /** The play log: its part and list (e.g. runtime.errors), cut last. */
  readonly log?: { readonly part: string; readonly list: string; readonly keep: readonly string[] };
}

/** Every list of rows in the value (to a small depth), with its path. A list of numbers is a value (a position, a size), not rows. */
function listsOf(v: Record<string, unknown>, path: string, depth: number, out: { path: string; list: unknown[] }[]): void {
  for (const [k, x] of Object.entries(v)) {
    const p = path === '' ? k : `${path}.${k}`;
    if (Array.isArray(x)) {
      if (!x.every((e) => typeof e === 'number')) out.push({ path: p, list: x });
    } else if (isObj(x) && depth < 4) listsOf(x, p, depth + 1, out);
  }
}

function fitWithin(source: Record<string, unknown>, budget: number, plan: FitPlan): Record<string, unknown> {
  const d = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const over = (): boolean => bytesOf(d) > budget;
  const lists: Record<string, number> = {};
  const merged: Record<string, number> = {};
  const omitted: string[] = [];
  let logEntries = 0;
  let errorEntries = 0;
  const logPart = plan.log !== undefined && isObj(d[plan.log.part]) ? (d[plan.log.part] as Record<string, unknown>) : null;
  const log = logPart !== null && Array.isArray(logPart[plan.log!.list]) ? (logPart[plan.log!.list] as unknown[]) : null;

  // Copies of one row become one row with a count (nothing is lost but the copies).
  const found: { path: string; list: unknown[] }[] = [];
  listsOf(d, '', 0, found);
  for (const f of found) {
    const m = mergeRepeatedRows(f.list);
    if (m.length < f.list.length) {
      merged[f.path] = f.list.length - m.length;
      f.list.splice(0, f.list.length, ...m);
    }
  }
  // The other lists, longest (in bytes) first, lose their oldest rows: half of what is left at a time.
  if (over()) {
    const others = found.filter((f) => f.list !== log && f.list.length > 0).sort((a, b) => bytesOf(b.list) - bytesOf(a.list));
    for (const f of others) {
      while (f.list.length > 0 && over()) {
        const n = Math.max(1, Math.floor(f.list.length / 2));
        f.list.splice(0, n);
        lists[f.path] = (lists[f.path] ?? 0) + n;
      }
      if (!over()) break;
    }
  }
  // The play log's oldest log lines (its errors stay).
  const dropFromLog = (errors: boolean): void => {
    if (log === null) return;
    for (let i = 0; i < log.length && over(); ) {
      if (isErrorRow(log[i]) === errors) {
        log.splice(i, 1);
        logEntries += 1;
        if (errors) errorEntries += 1;
      } else i += 1;
    }
  };
  if (over()) dropFromLog(false);
  // Whole parts, largest first: the answer's own, then the play log's part's other fields.
  if (over()) {
    const kept = new Set([...plan.keep, ...(plan.log !== undefined ? [plan.log.part] : [])]);
    for (const k of Object.keys(d).filter((x) => !kept.has(x)).sort((a, b) => bytesOf(d[b]) - bytesOf(d[a]))) {
      if (!over()) break;
      delete d[k];
      omitted.push(k);
    }
  }
  if (over() && logPart !== null) {
    const kept = new Set([plan.log!.list, ...plan.log!.keep]);
    for (const k of Object.keys(logPart).filter((x) => !kept.has(x)).sort((a, b) => bytesOf(logPart[b]) - bytesOf(logPart[a]))) {
      if (!over()) break;
      delete logPart[k];
      omitted.push(`${plan.log!.part}.${k}`);
    }
  }
  // Last, the oldest errors.
  if (over()) dropFromLog(true);
  return { ...d, trimmed: noteWithinRoom({ logEntries, errorEntries, lists, omitted, merged }) };
}

/** The paths of a by-path count with the most rows first, at most `n`; the rest summed under "…". */
function largestPaths(m: Readonly<Record<string, number>>, n: number): Readonly<Record<string, number>> {
  const rows = Object.entries(m).sort((a, b) => b[1] - a[1]);
  if (rows.length <= n) return m;
  return { ...Object.fromEntries(rows.slice(0, n)), '…': rows.slice(n).reduce((sum, [, v]) => sum + v, 0) };
}

/**
 * The note within its room: when it names many paths (a big answer cut in
 * many places), it keeps the paths that lost the most and counts the rest,
 * so the note never takes room from the answer (its errors above all).
 */
function noteWithinRoom(t: PlayDiagnosticsTrim): PlayDiagnosticsTrim {
  for (let n = 8; bytesOf({ trimmed: t }) > NOTE_ROOM && n >= 0; n -= n > 1 ? Math.ceil(n / 2) : 1) {
    const all = t.omitted.length;
    t = { ...t, lists: largestPaths(t.lists, n), merged: largestPaths(t.merged, n), omitted: all > n ? [...t.omitted.slice(0, n), `… ${all - n} more`] : t.omitted };
  }
  return t;
}

/** The answer as it is when it fits `maxBytes`; else a copy that fits, with a `trimmed` note (see the module comment for the order). */
function fitAnswer(answer: Record<string, unknown>, maxBytes: number, plan: FitPlan): Record<string, unknown> {
  if (bytesOf(answer) <= maxBytes) return answer;
  const fit = fitWithin(answer, Math.max(0, maxBytes - NOTE_ROOM), plan);
  // Over only when a part the plan keeps (an observation's header) is itself near the bound: everything else goes.
  return bytesOf(fit) <= maxBytes ? fit : fitWithin(answer, 0, plan);
}

/**
 * The diagnostics as they are when they fit `maxBytes`; else a copy that
 * fits, with a `trimmed` note: copies folded, the other lists' oldest rows,
 * the play log's (`runtime.errors`) oldest log lines, whole parts largest
 * first, and the play log's oldest errors last.
 */
export function fitPlayDiagnostics(diagnostics: Record<string, unknown>, maxBytes: number = PLAY_DIAGNOSTICS_MAX_BYTES): Record<string, unknown> {
  return fitAnswer(diagnostics, maxBytes, { keep: [], log: { part: 'runtime', list: 'errors', keep: ['errorCount', 'state', 'failed'] } });
}

/**
 * The parts of a game observation every answer carries (its identity, step
 * and play state, a failed run's error, and the sound status): what
 * `sections` never leaves out and trimming never cuts.
 */
export const GAME_OBSERVATION_HEADER = ['ok', 'playSessionId', 'snapshotId', 'buildId', 'runId', 'revision', 'observedAt', 'stepIndex', 'simTime', 'state', 'error', 'inputMode', 'sound'] as const;

/**
 * A game observation as it is when it fits `maxBytes`; else a copy that
 * fits, with a `trimmed` note: copies folded, the lists' oldest rows, then
 * whole parts largest first. The header (its identity, state and a failed
 * run's error) is never cut.
 */
export function fitGameObservation(observation: Record<string, unknown>, maxBytes: number = GAME_OBSERVATION_MAX_BYTES): Record<string, unknown> {
  return fitAnswer(observation, maxBytes, { keep: GAME_OBSERVATION_HEADER });
}
