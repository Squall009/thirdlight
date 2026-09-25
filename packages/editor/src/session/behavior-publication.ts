/**
 * Behavior publication workflow (packet 34; runtime.md §14.1/§14.2,
 * project-model §22, commands.md §3.1.4/§3.1.8/§8.8/§8.12).
 *
 * The editor's pure, Node-testable publication state machine. It owns:
 *
 *  - the **normative trust notice** the UI must present before offering an
 *    acknowledgment (runtime.md §14.2.2): no hard runtime timeout, no
 *    hostile-code sandbox, and scripts observe their game origin's globals
 *    while no credentials enter the preview;
 *  - the staged-source facts (digest + byte length) and the bounded
 *    compile/publication diagnostics (≤ 32, truncated flag) the server can
 *    return;
 *  - the exact typed command args for `acknowledgeBehaviorTrust` and
 *    `publishBehavior` (declaration and source modes). Source bytes are only
 *    ever *staged*; the published record carries `{ sourceDigest,
 *    sourceByteLength }` and never a caller-supplied manifest/output.
 *
 * It NEVER evaluates, imports or interprets behavior source: a source
 * evaluator is not part of the editor (packet 34's public-surface rule). The
 * state machine deliberately has no field that a staged edit can write except
 * `staged`, so "staged edits do not change active play or the published
 * revision" is structural, not a convention.
 */
import type { DeclaredProperty, PropertyDeclaration } from '@thirdlight/project-model';

/** The maximum bounded compile diagnostics the UI displays (project-model §22.4). */
export const COMPILE_DIAGNOSTIC_LIMIT = 32;

/**
 * The normative trust notice (runtime.md §14.1.1/§14.2.2). The UI must render
 * every line before enabling the acknowledgment button. The wording states
 * the three limitations explicitly and makes no safety claim.
 */
export const BEHAVIOR_TRUST_NOTICE: readonly string[] = Object.freeze([
  'Behavior code is trusted personal project code. It runs on the play page\u2019s main thread, in the same JavaScript context as the renderer and the runtime step loop.',
  '1. There is NO hard runtime timeout. A same-thread infinite loop (for example while (true) {}) cannot be interrupted: no watchdog, no Stop button, no iframe removal and no dispose() call is claimed to preempt it. A hung behavior hangs the play tab until you close it.',
  '2. There is NO hostile-code sandbox. A behavior can reach every global available in its game origin (window, document, fetch, XMLHttpRequest, WebSocket, Worker, storage, console) and can call them directly. The compiler\u2019s import/source checks and the preview CSP are defense in depth against accidental and structural mistakes, not a sandbox, and are trivially bypassable by design.',
  '3. Scripts observe their origin\u2019s globals. The preview page therefore exposes nothing sensitive: no authoring credentials, no authoring token, no /api/v1 access and no project filesystem handle ever enter the preview.',
]);

/** The acknowledgment button label (a reader must accept the notice). */
export const BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL = 'I understand the limits and acknowledge this exact source digest';

/** The source digest algorithm binding (project-model §22.1/§22.2). */
export const SOURCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface BehaviorStageView {
  stageId: string;
  digest: string;
  byteLength: number;
}

/** One bounded compile diagnostic as the UI displays it. */
export interface CompileDiagnosticView {
  code: string;
  reason: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  /** Phase 19.0: the visual-script node the diagnostic is about. */
  nodeId?: string;
}

/** The bounded compile failure the publication panel renders (≤ 32 entries). */
export interface CompileFailureView {
  code: string;
  reason: string;
  diagnostics: CompileDiagnosticView[];
  truncated: boolean;
}

export type PublicationStatus =
  | 'idle'
  | 'staged'
  | 'compile-failed'
  | 'publication-failed'
  | 'published';

/** The publication workflow state (the ONLY thing a staged edit may change). */
export interface BehaviorPublicationState {
  /** The staged source facts; `null` when nothing is staged. */
  staged: BehaviorStageView | null;
  /** Digests acknowledged in this session (from `acknowledgeBehaviorTrust`). */
  acknowledgedDigests: readonly string[];
  status: PublicationStatus;
  /** The last successful publication's revision (never changed by staging). */
  publishedRevision: number | null;
  compileFailure: CompileFailureView | null;
  error: { code: string; message: string } | null;
}

export function initialPublicationState(): BehaviorPublicationState {
  return {
    staged: null,
    acknowledgedDigests: [],
    status: 'idle',
    publishedRevision: null,
    compileFailure: null,
    error: null,
  };
}

/** Stage one source container (non-authoritative: no revision, no publication). */
export function sourceStaged(
  state: BehaviorPublicationState,
  stage: { stageId: string; digest: string; byteLength: number },
): BehaviorPublicationState {
  return {
    ...state,
    staged: { stageId: stage.stageId, digest: stage.digest, byteLength: stage.byteLength },
    status: 'staged',
    compileFailure: null,
    error: null,
  };
}

/** Record the acknowledged digests observed from a trust change/result. */
export function trustObserved(
  state: BehaviorPublicationState,
  entries: readonly { sourceDigest: string }[],
): BehaviorPublicationState {
  return {
    ...state,
    acknowledgedDigests: [...new Set(entries.map((e) => e.sourceDigest))].sort(),
  };
}

/** Bounded compile failure (project-model §22.4: ≤ 32 diagnostics, `truncated`). */
export function compileFailed(
  state: BehaviorPublicationState,
  failure: { code: string; reason: string; diagnostics?: readonly CompileDiagnosticView[] },
): BehaviorPublicationState {
  const all = failure.diagnostics ?? [];
  const diagnostics = all.slice(0, COMPILE_DIAGNOSTIC_LIMIT).map((d) => ({
    code: d.code,
    reason: d.reason,
    message: d.message.length > 256 ? `${d.message.slice(0, 255)}\u2026` : d.message,
    ...(d.path !== undefined ? { path: d.path } : {}),
    ...(d.line !== undefined ? { line: d.line } : {}),
    ...(d.column !== undefined ? { column: d.column } : {}),
  }));
  return {
    ...state,
    status: 'compile-failed',
    compileFailure: {
      code: failure.code,
      reason: failure.reason,
      diagnostics,
      truncated: all.length > COMPILE_DIAGNOSTIC_LIMIT,
    },
    error: null,
  };
}

/** A refused publication (unchanged revision, bounded error). */
export function publicationFailed(
  state: BehaviorPublicationState,
  error: { code: string; message: string },
): BehaviorPublicationState {
  return { ...state, status: 'publication-failed', error, compileFailure: null };
}

/** A successful publication (the served record advances the revision). */
export function published(
  state: BehaviorPublicationState,
  result: { revision: number },
): BehaviorPublicationState {
  return { ...state, status: 'published', publishedRevision: result.revision, error: null, compileFailure: null };
}

/** Is the current staged digest acknowledged (the §14.2 gate)? */
export function isStagedDigestAcknowledged(state: BehaviorPublicationState): boolean {
  return state.staged !== null && state.acknowledgedDigests.includes(state.staged.digest);
}

/** May the UI offer the source publication for the staged digest? */
export function canPublishStagedSource(state: BehaviorPublicationState): boolean {
  return state.staged !== null && isStagedDigestAcknowledged(state);
}

/**
 * A staged source edit. It returns a new state in which only `staged` (and the
 * status/error derived from staging) changed: `publishedRevision`,
 * `acknowledgedDigests`, and any active play/artifact outside this object are
 * untouched.
 */
export function stageSourceEdit(
  state: BehaviorPublicationState,
  stage: { stageId: string; digest: string; byteLength: number },
): BehaviorPublicationState {
  return sourceStaged(state, stage);
}

/** The exact `acknowledgeBehaviorTrust` args (commands.md §3.1.8/§8.12). */
export function planAcknowledgeTrust(sourceDigest: string): { sourceDigest: string } {
  if (!SOURCE_DIGEST_PATTERN.test(sourceDigest)) {
    throw new Error(`invalid source digest ${JSON.stringify(sourceDigest)}`);
  }
  return { sourceDigest };
}

/**
 * The exact `publishBehavior{mode:"source"}` args (commands.md §3.1.4/§8.8).
 * The published record is derived server-side from the preparation result;
 * the client supplies only the digest-bound facts.
 */
export function planPublishSource(args: {
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  sourceDigest: string;
  sourceByteLength: number;
}): {
  behaviorId: string;
  displayName: string;
  mode: 'source';
  declaration: PropertyDeclaration;
  source: { sourceDigest: string; sourceByteLength: number };
} {
  if (!SOURCE_DIGEST_PATTERN.test(args.sourceDigest)) {
    throw new Error(`invalid source digest ${JSON.stringify(args.sourceDigest)}`);
  }
  return {
    behaviorId: args.behaviorId,
    displayName: args.displayName,
    mode: 'source',
    declaration: cloneDeclaration(args.declaration),
    source: { sourceDigest: args.sourceDigest, sourceByteLength: args.sourceByteLength },
  };
}

/** The exact `publishBehavior` declaration-mode args (commands.md §3.1.4/§8.8). */
export function planPublishDeclaration(args: {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update';
  declaration: PropertyDeclaration;
}): {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update';
  declaration: PropertyDeclaration;
} {
  return {
    behaviorId: args.behaviorId,
    displayName: args.displayName,
    mode: args.mode,
    declaration: cloneDeclaration(args.declaration),
  };
}

/** The declared-property schema view the panel renders (never behavior code). */
export interface DeclarationSchemaView {
  behaviorId: string;
  displayName: string;
  properties: readonly DeclaredProperty[];
  hasSource: boolean;
  sourceDigest: string | null;
  publishedRevision: number;
  acknowledged: boolean;
}

/** Build the schema view from the published record + the observed trust set. */
export function declarationSchemaView(
  behavior: {
    behaviorId: string;
    displayName: string;
    declaration: PropertyDeclaration;
    source: { sourceDigest: string } | null;
    publishedRevision: number;
  },
  acknowledgedDigests: readonly string[],
): DeclarationSchemaView {
  const digest = behavior.source?.sourceDigest ?? null;
  return {
    behaviorId: behavior.behaviorId,
    displayName: behavior.displayName,
    properties: behavior.declaration.properties,
    hasSource: digest !== null,
    sourceDigest: digest,
    publishedRevision: behavior.publishedRevision,
    acknowledged: digest !== null && acknowledgedDigests.includes(digest),
  };
}

function cloneDeclaration(declaration: PropertyDeclaration): PropertyDeclaration {
  return { properties: declaration.properties.map((p) => ({ ...p })) };
}

