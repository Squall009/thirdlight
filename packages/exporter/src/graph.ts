/**
 * Export bundle import-graph check (export.md §4 step 4 / §5.2 — exact
 * allowed set, verified with the esbuild `--metafile` output):
 *
 *   export-bootstrap (packages/exporter/src/export-bootstrap.ts — that file
 *   only) → runtime → project-model (pure, inlined)
 *            → three-adapter → runtime, three
 *
 * Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
 * `commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond its
 * bootstrap file), and any `node:` builtin (browser platform).
 *
 * This is the export instance of the dependencies.md §5.3 bundle graph
 * check. Pure data processing over the metafile `inputs` map: no I/O.
 */

export interface GraphReport {
  ok: boolean;
  /** The forbidden module names (≤ 8 reported, export.md §4.1). */
  forbidden: string[];
}

const MAX_REPORTED = 8;

/** The allowed input locations (export.md §5.2). */
// (Inlined into the check below: the keys may be absolute or cwd-relative,
// so the match is on the package/tooling segment, not a leading slash.)

function normalize(p: string): string {
  // Metafile input keys are absolute OR cwd-relative (esbuild uses
  // absWorkingDir for the keys); normalize separators so the segment checks
  // are stable.
  return p.replace(/\\/g, '/');
}

/**
 * Reduce a path to its repo-relative form (from the `packages/` segment
 * on) so absolute and cwd-relative metafile keys compare equal. Returns the
 * normalized path unchanged when no `packages/` segment is present.
 */
function toRepoRel(p: string): string {
  const i = p.lastIndexOf('packages/');
  return i >= 0 ? p.slice(i) : p;
}

/**
 * Check every module in the esbuild metafile input graph.
 *
 * @param metafile the esbuild metafile (its `inputs` map: entry/module path
 *        → module record; keys may be absolute or cwd-relative)
 * @param bootstrapEntry the exact export-bootstrap file path (the only
 *        allowed `exporter` node)
 */
export function checkBundleGraph(
  metafile: { inputs: Record<string, unknown> },
  bootstrapEntry: string,
): GraphReport {
  const boot = toRepoRel(normalize(bootstrapEntry));
  const forbidden: string[] = [];

  for (const key of Object.keys(metafile.inputs ?? {})) {
    const p = normalize(key);

    // A Node builtin can never appear in a browser-platform graph.
    if (p.startsWith('node:')) {
      if (forbidden.length < MAX_REPORTED) forbidden.push(p);
      continue;
    }

    if (toRepoRel(p) === boot) continue;

    // The exporter package: ONLY its bootstrap file is allowed.
    if (p.includes('packages/exporter/')) {
      if (forbidden.length < MAX_REPORTED) forbidden.push(p);
      continue;
    }

    if (
      p.includes('packages/runtime/src/') ||
      p.includes('packages/three-adapter/src/') ||
      p.includes('packages/project-model/src/') ||
      p.includes('node_modules/three/')
    ) {
      continue;
    }

    // Everything else (backend, editor, workspace, commands, mcp-adapter,
    // protocol, or any other package/tooling) is forbidden.
    if (forbidden.length < MAX_REPORTED) {
      forbidden.push(p);
    }
  }

  return { ok: forbidden.length === 0, forbidden };
}