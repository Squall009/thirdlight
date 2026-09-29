/**
 * Script error and log locations in the editor.
 *
 * A Play's diagnostics carry each script error and `ctx.log` with where it
 * happened: `at` (a position in the compiled module the game ran) and, after
 * the backend mapped it with the build's source maps, `source` — the
 * behavior or library file, line and column the author wrote. These helpers
 * read those entries and name a location the way the code editor shows it.
 */

/** A position in the project's own sources. */
export interface SourceLocation {
  behaviorId?: string;
  libraryId?: string;
  path: string;
  line: number;
  column: number;
}

/** One Play console entry (a runtime diagnostics error-ring entry). */
export interface ConsoleEntry {
  code: string;
  /** For a log: its level (info | warn | error); for an error: the contract reason. */
  reason?: string;
  message: string;
  stepIndex?: number;
  moduleId?: string;
  /** The compiled position (`behaviors/<digest>.js:line:column`), when the runtime found one. */
  at?: { file: string; line: number; column: number };
  /** The mapped source position. */
  source?: SourceLocation;
  /** An error's mapped frames, innermost first (null: a frame without a mapping). */
  sources?: (SourceLocation | null)[];
}

/** A request to show a source position in its code editor tab (the nonce makes a repeat click count). */
export interface SourceFocus {
  /** The behaviorId (a script tab) or the libraryId (a library tab). */
  id: string;
  path: string;
  line: number;
  column?: number;
  nonce: number;
}

function isLocation(v: unknown): v is SourceLocation {
  const o = v as SourceLocation | null;
  return typeof o === 'object' && o !== null && typeof o.path === 'string' && Number.isInteger(o.line) && Number.isInteger(o.column);
}

/** The console entries of a Play's diagnostics answer (`diagnostics.runtime.errors`), oldest first. */
export function consoleEntriesOf(diagnostics: unknown): ConsoleEntry[] {
  const errors = (diagnostics as { runtime?: { errors?: unknown } } | null)?.runtime?.errors;
  if (!Array.isArray(errors)) return [];
  const out: ConsoleEntry[] = [];
  for (const raw of errors) {
    const e = raw as Record<string, unknown> | null;
    if (typeof e !== 'object' || e === null || typeof e['code'] !== 'string' || typeof e['message'] !== 'string') continue;
    const entry: ConsoleEntry = { code: e['code'], message: e['message'] };
    if (typeof e['reason'] === 'string') entry.reason = e['reason'];
    if (typeof e['stepIndex'] === 'number') entry.stepIndex = e['stepIndex'];
    if (typeof e['moduleId'] === 'string') entry.moduleId = e['moduleId'];
    const at = e['at'] as ConsoleEntry['at'] | undefined;
    if (at !== undefined && typeof at?.file === 'string') entry.at = at;
    if (isLocation(e['source'])) entry.source = e['source'];
    if (Array.isArray(e['sources'])) entry.sources = (e['sources'] as unknown[]).map((s) => (isLocation(s) ? s : null));
    out.push(entry);
  }
  return out;
}

/** `@lib/<id> · src/a.ts:3:7` or `<behaviorId> · src/index.ts:12:5`. */
export function describeLocation(loc: SourceLocation): string {
  const owner = loc.libraryId !== undefined ? `@lib/${loc.libraryId}` : (loc.behaviorId ?? '');
  return `${owner} · ${loc.path}:${loc.line}:${loc.column}`;
}

/** An unmapped compiled position, shortened (`behaviors/1a2b3c4d….js:7:3`). */
export function describeCompiled(at: { file: string; line: number; column: number }): string {
  const m = /^(behaviors|libraries)\/([0-9a-f]{8})[0-9a-f]{56}\.js$/.exec(at.file);
  return `${m !== null ? `${m[1]}/${m[2]}….js` : at.file}:${at.line}:${at.column}`;
}
