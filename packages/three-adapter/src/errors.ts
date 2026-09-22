/**
 * Three-adapter error model (packet 08; the dependencies.md §3 surface
 * row lists `ERROR_CODES` for the adapter — the code set below is the
 * adapter's stable set, recorded in docs/handoffs/08.md).
 *
 * Every public call returns a result object and never throws.
 */

export const ERROR_CODES = [
  /** The canvas argument is missing or does not expose `getContext`. */
  'canvas_invalid',
  /** No WebGL context could be created (non-browser environment, or
   *  WebGL unsupported by the browser). */
  'render_unsupported',
  /** A render/capture step failed after context creation (e.g. the
   *  runtime state is unavailable). */
  'render_failed',
  /** PNG capture failed (e.g. `toDataURL` unavailable). */
  'screenshot_failed',
  /** A method was called after `dispose()`. */
  'adapter_disposed',
  /** The WebGL context is currently lost; the frame was not rendered
   *  (packet 26). The context is restored lazily by the browser — the
   *  adapter releases nothing on loss and re-renders after restoration. */
  'render_context_lost',
  // --- packet 26: the shared GLB realization path (visual resources) --------
  /** The asset-byte source is missing/not a descriptor + bytes/resolver pair. */
  'asset_source_invalid',
  /** The injected resolver rejected, or returned no bytes (missing asset). */
  'asset_missing',
  /** The bytes are not the pinned version (length mismatch) or the loader
   *  rejected them (corrupt container/JSON). */
  'asset_corrupt',
  /** The GLB requires/uses an extension the visual profile cannot honor. */
  'asset_extension_unsupported',
  /** An embedded image could not be decoded (invalid image). */
  'asset_image_invalid',
  /** The loaded result carries a structurally invalid animation clip. */
  'asset_clip_invalid',
  /** The load was cancelled by its handle. */
  'asset_load_cancelled',
  /** The load was superseded by a newer load for the same asset and its
   *  late completion was discarded. */
  'asset_load_stale',
  /** A prepared visual resource (or a member of it) was used after `dispose()`. */
  'asset_disposed',
  /** An invalid preview argument (unknown clip index, non-finite time/delta). */
  'preview_invalid',
  // --- packet 52: the presentation code-set registration -------------------
  // presentation.md §41.7.2 D / §41.7.3: the code set is registered in THIS
  // packet; the `AnimationRoleController` that raises it is packet 53.
  /** The loaded version's clips do not satisfy the committed clip-role
   *  mapping (presentation.md §41.3.6 rule 7; validation class, hard). */
  'animation_role_unresolved',
  // --- packet 69: the M4 delivered-rendering `models` block (C64-4) -------
  // presentation.md §41.7.2 D / §41.9 row: the two new closed-set codes;
  // the adapter's set otherwise stays unchanged.
  /** The `models` block is structurally invalid against the snapshot
   *  (non-v3 scene with a models block, a missing loader port, or an
   *  `animation` entry naming an entity without `modelAnimation` / a
   *  mismatching `assetId`/`version` — delivery.md (M4) §2.2;
   *  validation class, hard). */
  'models_config_invalid',
  /** A `model` entity's `assetId` resolves to no declared `assets` row
   *  (defensive residual: unreachable for a well-formed capture — the
   *  closure includes every reachable asset; delivery.md (M4) §2.3;
   *  validation class, bounded diagnostic — the entity is realized as a
   *  plain group and the run proceeds). */
  'models_asset_unresolved',
] as const;

export type AdapterErrorCode = (typeof ERROR_CODES)[number];

/** One structured adapter error object. */
export interface AdapterError {
  code: AdapterErrorCode;
  /** ≤ 256 chars, log-safe. */
  message: string;
}

function clip(message: string): string {
  return message.length > 256 ? `${message.slice(0, 255)}…` : message;
}

export function adapterError(code: AdapterErrorCode, message: string): AdapterError {
  return { code, message: clip(message) };
}