/**
 * @thirdlight/exporter — stable error codes (export.md §4.1).
 *
 * Every failure of the export pipeline is one of these six codes, carried in
 * the standard `{ ok: false, error }` envelope (sessions.md §11.2 shape:
 * `code`, `cls`, `message` ≤ 256 chars, bounded `detail`). A failed export
 * leaves the previous output tree untouched and removes its own temp
 * directory (export.md §3/§4 — no partial "successful" artifacts, ever).
 */

export const ERROR_CODES = {
  /**
   * Step 1 — the project fails to load and/or the scene/snapshot fails
   * validation (workspace.md §4.3 + project-model §12 + the runtime.md §2
   * boundary re-validation of the constructed snapshot). Carries the
   * workspace/project-model error objects (≤ 10).
   */
  export_scene_invalid: 'export_scene_invalid',
  /**
   * Step 2 — the authoring revision advanced between the initial read and
   * the post-build re-read. The snapshot is no longer the current state:
   * re-export (the operator re-issues the operation).
   */
  export_snapshot_mismatch: 'export_snapshot_mismatch',
  /**
   * Step 3 — the output target is not under `<exportRoot>` or sits inside
   * the engine repository tree or a project's authoring tree (source/derived
   * separation).
   */
  export_output_path_invalid: 'export_output_path_invalid',
  /**
   * Step 4 — the bundle import graph (esbuild `--metafile`) contains a
   * forbidden module (export.md §5.2). A build/boundary defect, reported to
   * the operator with the offending module names (≤ 8). Also the report for
   * a build-time resolution failure (the bundle could not be built: its
   * defect surfaces as a graph/boundary defect per export.md §4).
   */
  export_bundle_graph_forbidden: 'export_bundle_graph_forbidden',
  /**
   * Step 5 — the forbidden-content scan (export.md §5.4) hit a pattern
   * outside the §5.4.1 recorded-exception scope. Carries ≤ 4 hits
   * `{ pattern, byteOffset, context ≤ 80 }`.
   */
  export_bundle_forbidden_content: 'export_bundle_forbidden_content',
  /**
   * Step 6 — the output writes failed (temp dir under `<exportRoot>` or the
   * atomic replacement). The previous tree (if any) is restored/untouched.
   */
  export_output_not_writable: 'export_output_not_writable',
} as const;

export type ExportErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** sessions.md §11.2 error classes (the subset the export pipeline uses). */
export type ExportErrorClass = 'validation' | 'conflict' | 'internal' | 'unavailable';

/** One structured export error (export.md §4: the `error` object). */
export interface ExportError {
  code: ExportErrorCode;
  cls: ExportErrorClass;
  /** ≤ 256 chars, log-safe, no secrets/paths. */
  message: string;
  /**
   * Bounded detail (export.md §4.1): `errors` (≤ 10, step 1), `modules`
   * (≤ 8, step 4), `hits` (≤ 4, step 5), revision facts (step 2).
   */
  detail?: {
    errors?: readonly unknown[];
    errorTotal?: number;
    modules?: readonly string[];
    hits?: readonly { pattern: string; byteOffset: number; context: string }[];
    frozenRevision?: number;
    currentRevision?: number;
    reason?: string;
  };
}

/** The standard result envelope of `exportProject` (export.md §4). */
export type ExportResult =
  | {
      ok: true;
      outputDir: string;
      snapshotId: string;
      revision: number;
      /** Byte sizes of the four emitted files (measured, not estimated). */
      files: Record<string, number>;
      /** Hits outside the §5.4.1 recorded-exception scope (0 for a success). */
      scanHits: number;
    }
  | { ok: false; error: ExportError };

/** Clip a message to the 256-char bound (sessions.md §11.2). */
export function clip(s: string): string {
  return s.length > 256 ? s.slice(0, 256) : s;
}