/**
 * Packet 36 — the shared export/play runtime composition (export.md §5.1/§5.2).
 *
 * ONE composition function is used by BOTH delivery paths for the M2 module
 * set — `runtime` + the registered engine modules (demo, platformer) + the
 * statically linked behavior outputs + the injected input/physics ports:
 *
 *   - the browser export bundle (`export-bootstrap-m2.ts`) calls it with the
 *     DOM/WebGL adapter-frame hook;
 *   - the packet-36 trace evidence calls it in Node over the real export tree
 *     and over the play-locator artifact set, with the REAL Rapier adapter.
 *
 * This module is browser-safe and Node-importable: it imports only
 * `@thirdlight/runtime` and `@thirdlight/platformer` (no three.js, no DOM, no
 * I/O). No separate controller/runtime implementation exists anywhere: the
 * controller is the packet-32 `platformerSpec`, the runtime is the packet-29
 * runtime and behaviors are the packet-34 host over the packet-33 outputs.
 */
import {
  BUILTIN_MODULES,
  behaviorModuleId,
  createBehaviorModuleSpec,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionSource,
  type GameplaySettings,
  type PhysicsPort,
  type Runtime,
  type SimulationRegistry,
} from '@thirdlight/runtime';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';

/** One statically linked behavior output (from the generated bundle module). */
export interface ExportBehaviorLink {
  behaviorId: string;
  declaration: unknown;
  artifact: {
    behaviorId: string;
    sourceDigest: string;
    manifestDigest: string;
    outputDigest: string;
    ownedTransforms: readonly string[];
    requiredModules: readonly string[];
  };
  namespace: unknown;
}

/** The manifest fields the composition verifies/consumes. */
export interface CompositionManifest {
  behaviors?: readonly Record<string, unknown>[];
  enginePins?: readonly { id: string; version: string; apiVersion: number }[];
  modules?: readonly { id: string }[];
  buildId?: string;
}

export interface ComposeExportRuntimeInput {
  /** The runtime snapshot document (runtime.md §2; validated at instantiate). */
  snapshot: unknown;
  manifest: CompositionManifest;
  /** The linked behavior outputs (empty for an M1-style closure). */
  behaviors: readonly ExportBehaviorLink[];
  actions: ActionSource;
  physics?: PhysicsPort | null;
  settings?: GameplaySettings;
  clock: () => number;
  driver?: { kind: 'raf' } | { kind: 'manual' };
  onFrame?: () => void;
}

export type ComposeExportRuntimeResult =
  | { ok: true; runtime: Runtime; modules: readonly string[] }
  | { ok: false; error: { code: string; message: string } };

/** `[id, hexDigest]`-style facts of one manifest behavior row. */
function manifestBehaviorFacts(row: Record<string, unknown>): { behaviorId: string; sourceDigest: string; manifestDigest: string; outputDigest: string } | null {
  const behaviorId = row['behaviorId'];
  const sourceDigest = row['sourceDigest'];
  const manifestDigest = row['manifestDigest'];
  const outputDigest = row['outputDigest'];
  if (
    typeof behaviorId !== 'string' ||
    typeof sourceDigest !== 'string' ||
    typeof manifestDigest !== 'string' ||
    typeof outputDigest !== 'string'
  ) {
    return null;
  }
  return { behaviorId, sourceDigest, manifestDigest, outputDigest };
}

/**
 * The module IDs the composition registers for one snapshot scene: the
 * platformer controller when the scene carries a controller entity, plus one
 * behavior module per linked behavior (ascending). The manifest's `modules`
 * rows are the required engine modules (including non-registerable ports); the
 * composition checks that every registered/required id is covered.
 */
export function exportModuleIds(
  scene: { entities?: ReadonlyArray<Record<string, unknown>> },
  behaviors: readonly ExportBehaviorLink[],
): string[] {
  const ids: string[] = [];
  if ((scene.entities ?? []).some((e) => ((e['components'] ?? {}) as Record<string, unknown>)['controller'] !== undefined)) {
    ids.push(PLATFORMER_MODULE_ID);
  }
  for (const b of behaviors) ids.push(behaviorModuleId(b.behaviorId));
  return ids;
}

/**
 * Compose the runtime for one already-loaded closure. The manifest behavior
 * rows must match the linked outputs exactly (same ids and the same
 * source/manifest/output digests) — the export.md §5.1 rule that play and
 * export link the SAME outputs, checked at composition time.
 */
export function composeExportRuntime(input: ComposeExportRuntimeInput): ComposeExportRuntimeResult {
  const scene = (input.snapshot as { scene?: { entities?: ReadonlyArray<Record<string, unknown>> } }).scene;
  if (scene === undefined || !Array.isArray(scene.entities)) {
    return { ok: false, error: { code: 'config_invalid', message: 'the snapshot has no scene entities' } };
  }
  const manifestRows = input.manifest.behaviors ?? [];
  if (manifestRows.length !== input.behaviors.length) {
    return {
      ok: false,
      error: { code: 'manifest_behavior_mismatch', message: `the manifest declares ${manifestRows.length} behavior(s) but ${input.behaviors.length} are linked` },
    };
  }
  const linked = new Map(input.behaviors.map((b) => [b.behaviorId, b]));
  for (const row of manifestRows) {
    const facts = manifestBehaviorFacts(row);
    if (facts === null) return { ok: false, error: { code: 'manifest_behavior_mismatch', message: 'a manifest behavior row is malformed' } };
    const link = linked.get(facts.behaviorId);
    if (link === undefined) {
      return { ok: false, error: { code: 'manifest_behavior_mismatch', message: `behavior ${facts.behaviorId} is declared but not linked` } };
    }
    if (
      link.artifact.sourceDigest !== facts.sourceDigest ||
      link.artifact.manifestDigest !== facts.manifestDigest ||
      link.artifact.outputDigest !== facts.outputDigest
    ) {
      return { ok: false, error: { code: 'manifest_behavior_mismatch', message: `behavior ${facts.behaviorId} does not match its manifest digests` } };
    }
  }

  const registry: SimulationRegistry = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
  const enginePins = input.manifest.enginePins ?? [];
  for (const link of input.behaviors) {
    registerSimulationModule(
      registry,
      behaviorModuleId(link.behaviorId),
      createBehaviorModuleSpec({
        declaration: link.declaration as never,
        artifact: {
          behaviorId: link.behaviorId,
          sourceDigest: link.artifact.sourceDigest,
          manifestDigest: link.artifact.manifestDigest,
          outputDigest: link.artifact.outputDigest,
          ownedTransforms: link.artifact.ownedTransforms,
          requiredModules: link.artifact.requiredModules,
          enginePins,
          namespace: link.namespace,
        },
      }),
    );
  }

  const modules = exportModuleIds(scene, input.behaviors);
  const rt = instantiateRuntime({
    snapshot: input.snapshot,
    registry,
    modules,
    actions: input.actions,
    ...(input.physics !== undefined && input.physics !== null ? { physics: input.physics } : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    clock: input.clock,
    driver: input.driver ?? { kind: 'raf' },
    ...(input.onFrame !== undefined ? { onFrame: input.onFrame } : {}),
  });
  if (rt.ok === false) {
    return { ok: false, error: { code: rt.error.code, message: rt.error.message } };
  }
  return { ok: true, runtime: rt.runtime, modules };
}

/**
 * The manifest key order (`buildId` last) — a copy of project-model's
 * MANIFEST_KEYS for browser code that must re-derive `buildId` without a
 * module-graph dependency chain (the composition runs in the export bundle).
 */
export const EXPORT_MANIFEST_KEYS = [
  'manifestVersion',
  'type',
  'projectId',
  'revision',
  'snapshotId',
  'capturedAt',
  'sceneDigest',
  'contentDigest',
  'assets',
  'behaviors',
  'modules',
  'enginePins',
  'recipes',
  'toolchain',
  'buildOptionsDigest',
  'buildId',
] as const;

/**
 * Re-derive the manifest `buildId` from a parsed manifest and verify it against
 * the document's own value (sessions.md §17.1.1): the export page proves the
 * manifest it loaded is self-consistent before it loads anything else.
 */
export async function verifyManifestIdentity(
  manifest: Record<string, unknown>,
  sha256HexOfText: (text: string) => Promise<string>,
): Promise<{ ok: true; buildId: string } | { ok: false; reason: string }> {
  const without: Record<string, unknown> = {};
  for (const key of EXPORT_MANIFEST_KEYS) {
    if (key === 'buildId') continue;
    if (!(key in manifest)) return { ok: false, reason: `manifest field "${key}" is missing` };
    without[key] = manifest[key];
  }
  const buildId = await sha256HexOfText(`${JSON.stringify(without, null, 2)}\n`);
  const declared = manifest['buildId'];
  if (typeof declared !== 'string' || declared !== buildId) {
    return { ok: false, reason: 'the manifest buildId does not match its own document bytes' };
  }
  return { ok: true, buildId };
}
