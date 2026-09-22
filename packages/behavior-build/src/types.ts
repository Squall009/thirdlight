/**
 * Public types of `@thirdlight/behavior-build` (project-model.md §22,
 * behaviors.md §5; dependencies.md §3 export row).
 *
 * `BehaviorCompileInput`, `BehaviorCompileResult`, `BehaviorManifest`,
 * `CompileDiagnostic` and `PinnedModuleRef` follow the contract shapes; the
 * packet-33 additions (`BehaviorCompiler`, `PreparedBehaviorSource`,
 * `BehaviorCompileOptions`, `SourceGraphContainer`/`SourceGraphAnalysis`) are
 * additive and recorded in the packet-33 handoff.
 */

import type { DeclaredProperty } from '@thirdlight/project-model';

/** A pinned engine module the host allows a behavior graph to name (types only). */
export interface PinnedModuleRef {
  /** e.g. `@thirdlight/runtime`. */
  readonly id: string;
  /** exact pin, e.g. `0.1.0`. */
  readonly version: string;
  /** the module API version. */
  readonly apiVersion: number;
}

/** The compiler resource bounds (project-model.md §22.4 / behaviors.md §6). */
export interface BehaviorCompilerLimits {
  /** files per source graph. */
  files: number;
  /** bytes per file (`text` UTF-8). */
  fileBytes: number;
  /** total container bytes (`sourceByteLength`). */
  graphBytes: number;
  /** longest relative import chain from the entry. */
  importDepth: number;
  /** import declarations per file. */
  importsPerFile: number;
  /** `ownedTransforms` entries. */
  ownedTransforms: number;
  /** diagnostics per compile (excess dropped, `truncated` recorded). */
  diagnostics: number;
  /** compile wall-clock bound in ms (cooperative, injected clock). */
  timeoutMs: number;
  /** output bytes. */
  outputBytes: number;
  /** properties per declaration (re-checked here; owned by properties.md §4). */
  properties: number;
  /** canonical declaration bytes (re-checked here). */
  declarationBytes: number;
}

/** One bounded compile diagnostic (≤ 256 chars, log-safe, host-path-free). */
export interface CompileDiagnostic {
  code: string;
  reason: string;
  path?: string;
  line?: number;
  column?: number;
  message: string;
}

/** The `compileBehavior` input (behaviors.md §5.1). */
export interface BehaviorCompileInput {
  /** ID syntax (project-model.md §5.1). */
  readonly behaviorId: string;
  /** The digest-bound declaration the publication will assert. */
  readonly declaration: { readonly properties: readonly DeclaredProperty[] };
  /** The exact canonical source-graph container bytes. */
  readonly containerBytes: Uint8Array;
  /** The host's pinned module table (ascending by id, unique). */
  readonly pinnedModules: readonly PinnedModuleRef[];
  /** Partial bound overrides; absent keys keep the M2 defaults. */
  readonly limits?: Partial<BehaviorCompilerLimits>;
  /**
   * Host-supplied literal patterns (the configured authoring/preview origins
   * and token values) scanned in the output as letters `a`/`b`/`i`; absent in
   * the pure compiler default (export.md §5.4 owns those host strings).
   */
  readonly forbiddenStrings?: readonly string[];
}

/** The canonical, digest-bound compile result (behaviors.md §5.2). */
export interface BehaviorManifest {
  manifestVersion: 1;
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  entryPath: 'src/index.ts';
  files: { path: string; digest: string; byteLength: number }[];
  requiredModules: string[];
  ownedTransforms: string[];
  enginePins: { id: string; version: string; apiVersion: number }[];
  declaration: { properties: DeclaredProperty[] };
  apiVersion: number;
  compiler: { id: string; version: string; esbuild: string; typescript: string };
  outputDigest: string;
  outputByteLength: number;
}

export interface BehaviorCompileSuccess {
  ok: true;
  manifest: BehaviorManifest;
  /** `canonicalJsonText(manifest) + "\n"` — the bytes `manifestDigest` covers. */
  manifestBytes: Uint8Array;
  manifestDigest: string;
  /** The linked module artifact (esbuild output, `format: 'esm'`). */
  outputBytes: Uint8Array;
  outputDigest: string;
  /** Digest of the compile recipe (compiler/esbuild/pins/limits/declaration). */
  recipeDigest: string;
  /** Digest of the canonical declaration bytes. */
  declarationDigest: string;
  diagnostics: readonly CompileDiagnostic[];
}

export interface BehaviorCompileFailure {
  ok: false;
  code: string;
  reason: string;
  /** The exceeded bound name, when the failure is a bound. */
  limit?: string;
  /** Observed value for a bound failure. */
  current?: number;
  /** Bound value for a bound failure. */
  max?: number;
  /** The resolved path/cycle/module id the failure names, when applicable. */
  detail?: string;
  diagnostics: readonly CompileDiagnostic[];
}

export type BehaviorCompileResult = BehaviorCompileSuccess | BehaviorCompileFailure;

/** One file of the canonical source-graph container (§22.1). */
export interface SourceGraphFile {
  path: string;
  text: string;
}

/** The canonical source-graph container (`thirdlight-behavior-source` v1). */
export interface SourceGraphContainer {
  graphVersion: 1;
  entryPath: string;
  requiredModules: string[];
  ownedTransforms: string[];
  files: SourceGraphFile[];
}

/** The derived static analysis of one accepted container (steps 1–12). */
export interface SourceGraphAnalysis {
  entryPath: string;
  fileCount: number;
  fileByteLengths: { path: string; byteLength: number }[];
  requiredModules: string[];
  ownedTransforms: string[];
  /** `[from, to]` resolved relative edges, file order then text position. */
  relativeEdges: [string, string][];
  importDepth: number;
  typeOnlyImports: number;
  acceptedImports: number;
}

export type SourceGraphParseResult =
  | { ok: true; container: SourceGraphContainer; analysis: SourceGraphAnalysis }
  | { ok: false; failure: BehaviorCompileFailure };

/**
 * The digest-bound prepared result of one successful preparation
 * (project-model.md §22.4.1 step 5). The workspace persists it as a derived
 * cache entry and the `publishBehavior` source branch consumes it; it is the
 * only source the record fields are derived from.
 */
export interface PreparedBehaviorSource {
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  entryPath: 'src/index.ts';
  fileCount: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  requiredModules: string[];
  ownedTransforms: string[];
  /** The canonical declaration the manifest was compiled with. */
  declaration: { properties: DeclaredProperty[] };
  declarationDigest: string;
  recipeDigest: string;
  compiler: { id: string; version: string; esbuild: string; typescript: string };
}

/** The injectable compiler instance (workspace's `prepareBehaviorSource` seam). */
export interface BehaviorCompiler {
  /** The host's pinned module table (a fact the preparer copies into the input). */
  readonly pinnedModules: readonly PinnedModuleRef[];
  compile(input: BehaviorCompileInput): Promise<BehaviorCompileResult>;
}

/** Host seams for `compileBehavior` (clock for the cooperative bound, build impl). */
export interface BehaviorCompileOptions {
  /**
   * Injected monotonic wall clock in ms. Absent ⇒ no timeout measurement (the
   * pure compiler reads no clock); the preparer injects it.
   */
  now?: () => number;
  /**
   * The build implementation (defaults to the pinned esbuild `buildSync`). A
   * test seam only: content never supplies a plugin/hook (behaviors.md §5.4).
   */
  build?: (options: unknown) => Promise<{ outputFiles?: { contents: Uint8Array }[] }>;
}
