/**
 * Behavior publication: what the editor shows and sends around publishing a
 * script.
 *
 *  - the **normative trust notice** the UI must present before offering an
 *    acknowledgment: no hard runtime timeout, no hostile-code sandbox, and
 *    scripts observe their game origin's globals while no credentials enter
 *    the preview;
 *  - the bounded compile diagnostics the server can return;
 *  - the exact typed command args for `acknowledgeBehaviorTrust` and
 *    `publishBehavior` (declaration and source modes). Source bytes are only
 *    ever *staged*; the published record carries `{ sourceDigest,
 *    sourceByteLength }` and never a caller-supplied manifest/output.
 *
 * It never evaluates, imports or interprets behavior source: a source
 * evaluator is not part of the editor's public surface.
 */
import type { PropertyDeclaration } from '@thirdlight/project-model';
import { DIGEST_RE } from '@thirdlight/project-model/content-helpers';

/**
 * The normative trust notice, defined here only: the editor is the one place
 * a source is acknowledged (an export refuses an unacknowledged source rather
 * than asking). The UI must render every line before enabling the
 * acknowledgment button. The wording states the three limitations explicitly,
 * covers both simulation threads and makes no safety claim.
 */
export const BEHAVIOR_TRUST_NOTICE: readonly string[] = Object.freeze([
  'Behavior code is trusted personal project code. It runs in the game\u2019s simulation worker, or on the page\u2019s main thread when the project\u2019s Simulation thread setting or the page\u2019s ?threads=off says so, in the same JavaScript context as the runtime step loop. The same holds in Play and in an exported game.',
  '1. There is NO hard runtime timeout. An infinite loop (for example while (true) {}) cannot be interrupted: no watchdog, no Stop button and no dispose() call is claimed to preempt it. A hung behavior stops the game; on the main thread it also hangs the tab until you close it.',
  '2. There is NO hostile-code sandbox. A behavior can reach every global of its thread in its game origin (fetch, XMLHttpRequest, WebSocket, Worker, IndexedDB, console; on the main thread also window, document and storage) and can call them directly. The compiler\u2019s import/source checks and the preview CSP are defense in depth against accidental and structural mistakes, not a sandbox, and are trivially bypassable by design.',
  '3. Scripts observe their origin\u2019s globals. The preview page therefore exposes nothing sensitive: no authoring credentials, no authoring token, no /api/v1 access and no project filesystem handle ever enter the preview.',
]);

/** The acknowledgment button label (a reader must accept the notice). */
export const BEHAVIOR_TRUST_ACKNOWLEDGE_LABEL = 'I understand the limits and acknowledge this exact source digest';

/** One bounded compile diagnostic as the UI displays it. */
export interface CompileDiagnosticView {
  code: string;
  reason: string;
  message: string;
  path?: string;
  line?: number;
  column?: number;
  /** The visual-script node the diagnostic is about. */
  nodeId?: string;
  /** The script library whose file `path` names (absent: the script's own file). */
  library?: string;
}

/** The exact `acknowledgeBehaviorTrust` args. */
export function planAcknowledgeTrust(sourceDigest: string): { sourceDigest: string } {
  if (!DIGEST_RE.test(sourceDigest)) {
    throw new Error(`invalid source digest ${JSON.stringify(sourceDigest)}`);
  }
  return { sourceDigest };
}

/**
 * The exact `publishBehavior{mode:"source"}` args.
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
  if (!DIGEST_RE.test(args.sourceDigest)) {
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

/** The exact `publishBehavior` declaration-mode args. */
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

function cloneDeclaration(declaration: PropertyDeclaration): PropertyDeclaration {
  return { properties: declaration.properties.map((p) => ({ ...p })) };
}

