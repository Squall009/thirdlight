/**
 * Phase 25.9: script error and log locations back to the project's sources.
 *
 * The runtime records where a script error was thrown and where a `ctx.log`
 * was called as positions in the compiled modules it ran
 * (`behaviors/<digest>.js`, `libraries/<digest>.js`: `at`, and for errors a
 * few `frames`). A Play keeps its compiled outputs' source maps (never
 * served); this maps each position to the behavior or library file, line and
 * column the author wrote. A position without a map (a Play debug build of a
 * visual script, the engine's own code) stays as it is, unmapped.
 */
import { originalPosition, sourceFileOf } from '@thirdlight/behavior-build';

/** A compiled position as the runtime records it. */
export interface CompiledLocation {
  file: string;
  line: number;
  column: number;
}

/** The same position in the project's sources. */
export interface SourceLocation {
  behaviorId?: string;
  libraryId?: string;
  path: string;
  line: number;
  column: number;
}

export type SourceMapTable = ReadonlyMap<string, { behaviorId?: string; libraryId?: string; sourceMap: string }>;

const COMPILED_FILE_RE = /^(behaviors|libraries)\/([0-9a-f]{64})\.js$/;

function isLocation(v: unknown): v is CompiledLocation {
  const o = v as CompiledLocation | null;
  return typeof o === 'object' && o !== null && typeof o.file === 'string' && Number.isInteger(o.line) && Number.isInteger(o.column);
}

/** Map one compiled position (null: not a project module of this Play, or no mapping there). */
export function mapCompiledLocation(at: CompiledLocation, maps: SourceMapTable): SourceLocation | null {
  const m = COMPILED_FILE_RE.exec(at.file);
  if (m === null) return null;
  const entry = maps.get(m[2] as string);
  if (entry === undefined || entry.sourceMap.length === 0) return null;
  const pos = originalPosition(entry.sourceMap, at.line, at.column);
  if (pos === null) return null;
  const file = sourceFileOf(pos.source);
  if (file === null) return null;
  // A behavior's own map names its files; a library's map its library's (a bundled library in a record
  // published before shared libraries names the library itself).
  const libraryId = file.library ?? entry.libraryId;
  return {
    ...(libraryId !== undefined ? { libraryId } : entry.behaviorId !== undefined ? { behaviorId: entry.behaviorId } : {}),
    path: file.path,
    line: pos.line,
    column: pos.column,
  };
}

/**
 * Add `source` (and `sources` for an error's frames) to each runtime error
 * entry of a Play's diagnostics that carries compiled positions. Returns the
 * diagnostics unchanged when nothing maps.
 */
export function withSourceLocations(diagnostics: unknown, maps: SourceMapTable | undefined): unknown {
  if (maps === undefined || maps.size === 0) return diagnostics;
  const d = diagnostics as { runtime?: { errors?: unknown } } | null;
  const errors = d?.runtime?.errors;
  if (!Array.isArray(errors)) return diagnostics;
  let changed = false;
  const mapped = errors.map((raw: unknown) => {
    const e = raw as { at?: unknown; frames?: unknown } | null;
    if (typeof e !== 'object' || e === null) return raw;
    const out: Record<string, unknown> = { ...(e as Record<string, unknown>) };
    if (isLocation(e.at)) {
      const s = mapCompiledLocation(e.at, maps);
      if (s !== null) {
        out['source'] = s;
        changed = true;
      }
    }
    if (Array.isArray(e.frames)) {
      const sources = e.frames.map((f) => (isLocation(f) ? mapCompiledLocation(f, maps) : null));
      if (sources.some((s) => s !== null)) {
        out['sources'] = sources;
        changed = true;
      }
    }
    return out;
  });
  if (!changed) return diagnostics;
  return { ...(d as object), runtime: { ...(d!.runtime as object), errors: mapped } };
}
