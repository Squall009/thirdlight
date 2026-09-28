/**
 * Phase 25.9: compiled positions back to source files (source map v3, the
 * maps the compiler emits next to each behavior and shared library output).
 *
 * `originalPosition(map, line, column)` decodes only the generated line it is
 * asked about. `sourceFileOf(source)` turns a map's source name (the
 * compiler's in-memory namespaces) into the stored path an author sees.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Map([...B64].map((c, i) => [c, i] as const));

/** Decode one mapping segment's VLQ fields (null: malformed). */
function decodeSegment(segment: string): number[] | null {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const c of segment) {
    const digit = B64_VALUE.get(c);
    if (digit === undefined) return null;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      if (shift > 30) return null;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return shift === 0 ? out : null;
}

export interface OriginalPosition {
  /** The map's source name (see `sourceFileOf`). */
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

/**
 * The source position of a generated position (both 1-based), or null when
 * the map has none (a position in generated glue, a malformed map).
 */
export function originalPosition(mapText: string, line: number, column: number): OriginalPosition | null {
  let map: { version?: unknown; sources?: unknown; mappings?: unknown };
  try {
    map = JSON.parse(mapText) as typeof map;
  } catch {
    return null;
  }
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string') return null;
  const sources = map.sources as unknown[];
  const lines = map.mappings.split(';');
  if (!Number.isInteger(line) || line < 1 || line > lines.length || !Number.isInteger(column) || column < 1) return null;
  // Source index, source line and source column are relative across the whole map: walk every line before.
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let best: OriginalPosition | null = null;
  for (let l = 0; l < line; l += 1) {
    let genCol = 0;
    const text = lines[l] as string;
    if (text.length === 0) continue;
    for (const segment of text.split(',')) {
      const f = decodeSegment(segment);
      if (f === null || f.length === 0) return null;
      genCol += f[0] as number;
      if (f.length >= 4) {
        src += f[1] as number;
        srcLine += f[2] as number;
        srcCol += f[3] as number;
      }
      if (l === line - 1 && f.length >= 4 && genCol <= column - 1) {
        const name = sources[src];
        if (typeof name === 'string') best = { source: name, line: srcLine + 1, column: srcCol + 1 };
      }
    }
  }
  return best;
}

/**
 * A map source name as an author's file: the compiler's in-memory namespaces
 * (`tl-behavior-memory:src/a.ts`, `tl-lib-own:src/a.ts`) dropped. A link stub
 * (`tl-lib-link:<id>`) or a bundled library module (`tl-lib:<id>/<path>`) is
 * reported with its library. Null: not a project file.
 */
export function sourceFileOf(source: string): { path: string; library?: string } | null {
  const bundled = /^tl-lib:([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/.exec(source);
  if (bundled !== null) return { library: bundled[1] as string, path: bundled[2] as string };
  if (source.startsWith('tl-lib-link:')) return null;
  const path = source.replace(/^[a-z-]+:/, '').replace(/^\/+/, '');
  return /^[a-z0-9][a-z0-9._/-]*\.(ts|json)$/.test(path) ? { path } : null;
}
