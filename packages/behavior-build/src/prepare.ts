/**
 * The digest-bound preparation result builder (project-model.md §22.4.1 step 5,
 * behaviors.md §8.4): one successful `compileBehavior` becomes the
 * `PreparedBehaviorSource` fact set the workspace persists as a derived cache
 * and the `publishBehavior` source branch consumes. Every field is derived
 * from the compiler's own manifest/output — no caller-supplied source field is
 * copied into it.
 */

import type {
  BehaviorCompileInput,
  BehaviorCompileResult,
  BehaviorCompiler,
  BehaviorCompileSuccess,
  BehaviorCompileFailure,
  PreparedBehaviorSource,
} from './types';

export type BehaviorPrepareResult =
  | { ok: true; prepared: PreparedBehaviorSource; outputBytes: Uint8Array; manifestBytes: Uint8Array }
  | { ok: false; failure: BehaviorCompileFailure };

/** Derive the prepared record from a successful compile result. */
export function preparedSourceFrom(result: BehaviorCompileSuccess): PreparedBehaviorSource {
  const m = result.manifest;
  return {
    behaviorId: m.behaviorId,
    sourceDigest: m.sourceDigest,
    sourceByteLength: m.sourceByteLength,
    entryPath: 'src/index.ts',
    fileCount: m.files.length,
    manifestDigest: result.manifestDigest,
    outputDigest: m.outputDigest,
    outputByteLength: m.outputByteLength,
    requiredModules: [...m.requiredModules],
    ownedTransforms: [...m.ownedTransforms],
    declaration: { properties: m.declaration.properties.map((p) => ({ ...p })) },
    ...(m.declaredInCode === true ? { declaredInCode: true as const } : {}),
    ...(m.sourceKind === 'graph' ? { sourceKind: 'graph' as const } : {}),
    ...(m.libraries !== undefined && m.libraries.length > 0 ? { libraries: m.libraries.map((p) => ({ ...p })) } : {}),
    declarationDigest: result.declarationDigest,
    recipeDigest: result.recipeDigest,
    compiler: { ...m.compiler },
  };
}

/**
 * Run the injected compiler over the supplied bytes and build the digest-bound
 * prepared result. A compile failure produces no bytes and no record.
 */
export async function prepareBehavior(compiler: BehaviorCompiler, input: BehaviorCompileInput): Promise<BehaviorPrepareResult> {
  const result: BehaviorCompileResult = await compiler.compile(input);
  if (!result.ok) return { ok: false, failure: result };
  return {
    ok: true,
    prepared: preparedSourceFrom(result),
    outputBytes: result.outputBytes,
    manifestBytes: result.manifestBytes,
  };
}
