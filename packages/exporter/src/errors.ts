/**
 * @thirdlight/exporter — stable error codes.
 *
 * Every failure of the export pipeline is one of these six codes, carried in
 * the standard `{ ok: false, error }` envelope (the sessions.md shape:
 * `code`, `cls`, `message` ≤ 256 chars, bounded `detail`). A failed export
 * leaves the previous output tree untouched and removes its own temp
 * directory (no partial "successful" artifacts, ever).
 */

export const ERROR_CODES = {
  /**
   * Step 1 — the project fails to load and/or the scene/snapshot fails
   * validation (workspace.md + project-model + the runtime.md boundary
   * re-validation of the constructed snapshot). Carries the
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
   * forbidden module. A build/boundary defect, reported to
   * the operator with the offending module names (≤ 8). Also the report for
   * a build-time resolution failure (the bundle could not be built: its
   * defect surfaces as a graph/boundary defect).
   */
  export_bundle_graph_forbidden: 'export_bundle_graph_forbidden',
  /**
   * Step 5 — the forbidden-content scan hit a pattern
   * outside the recorded-exception scope. Carries ≤ 4 hits
   * `{ pattern, byteOffset, context ≤ 80 }`.
   */
  export_bundle_forbidden_content: 'export_bundle_forbidden_content',
  /**
   * Step 6 — the output writes failed (temp dir under `<exportRoot>` or the
   * atomic replacement). The previous tree (if any) is restored/untouched.
   */
  export_output_not_writable: 'export_output_not_writable',
  /**
   * Step 5a — the runtime-content manifest fails its self-identity check
   * (the recomputed `buildId`, the declared-path closure, the digest of the
   * emitted scene document) or the closure derivation failed.
   */
  export_manifest_invalid: 'export_manifest_invalid',
  /**
   * A derived bundle/behavior build failed (the behavior compiler or the
   * bundle build). The previous output tree is preserved.
   */
  export_build_unavailable: 'export_build_unavailable',
  /**
   * Step 5b — a format-aware scan hit (GLB container, WASM container, the
   * relative-closure rule). The play build reports the same code.
   */
  scan_forbidden_content: 'scan_forbidden_content',
  /**
   * A reachable `source`-bearing behavior has no trust acknowledgment.
   * Structurally unreachable through the accepted public reads (the workspace
   * refuses an unacknowledged source publication); kept in the stable code
   * set.
   */
  behavior_trust_unacknowledged: 'behavior_trust_unacknowledged',
} as const;

export type ExportErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** sessions.md error classes (the subset the export pipeline uses). */
export type ExportErrorClass = 'validation' | 'conflict' | 'internal' | 'unavailable';

/** One structured export error (the `error` object). */
export interface ExportError {
  code: ExportErrorCode;
  cls: ExportErrorClass;
  /** ≤ 256 chars, log-safe, no secrets/paths. */
  message: string;
  /**
   * Bounded detail: `errors` (≤ 10, step 1), `modules`
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
    /** Every asset whose file is missing (the export refuses naming them all). */
    missingFiles?: readonly import('@thirdlight/project-model').MissingPlayFile[];
  };
}

/** The standard result envelope of `exportProject`. */
export type ExportResult =
  | {
      ok: true;
      outputDir: string;
      snapshotId: string;
      revision: number;
      /** Byte sizes of the emitted files (measured, not estimated). */
      files: Record<string, number>;
      /** Hits outside the recorded-exception scope (0 for a success). */
      scanHits: number;
      /** `meta.json.schemaVersion`. */
      schemaVersion?: number;
      /** The runtime-content manifest identity. */
      buildId?: string;
      /** The captured content-view digest. */
      contentDigest?: string;
      /** The emitted-closure digest recorded in `meta.json`. */
      outputDigest?: string;
      /** The start's warnings (scene rules checked before a start; one Problems line each). */
      warnings?: readonly { code: string; message: string }[];
    }
  | { ok: false; error: ExportError };

/** Clip a message to the 256-char bound. */
export function clip(s: string): string {
  return s.length > 256 ? s.slice(0, 256) : s;
}