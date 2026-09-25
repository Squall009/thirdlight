/**
 * @thirdlight/behavior-build — public surface (dependencies.md §3 row:
 * `.` → `compileBehavior`, `COMPILER_LIMITS`, `COMPILER_ID`,
 * `BehaviorCompileInput`, `BehaviorCompileResult`, `BehaviorManifest`,
 * `CompileDiagnostic`, `PinnedModuleRef`).
 *
 * Packet-33 additive exports (recorded in the packet-33 handoff):
 * `createBehaviorCompiler`, `prepareBehavior`, `preparedSourceFrom`,
 * `parseSourceGraphContainer`, `analyzeSourceGraph`, `manifestBytesOf`,
 * `compileRecipeDigest`, `scanOutput`, `M2_PINNED_MODULES`,
 * `OUTPUT_SCAN_PATTERNS`, `COMPILER_OPTIONS` and the supporting types.
 *
 * Node-side, pure and closed: no I/O, no evaluation, no Node builtins, no
 * runtime/three/editor/backend/workspace/commands/protocol edge. The compiler
 * instance is injected by the host (`backend` constructs it; `workspace`
 * holds only its type).
 */

export { COMPILER_ID, COMPILER_LIMITS, COMPILER_OPTIONS, COMPILER_VERSION, ENTRY_PATH, ESBUILD_PIN, TYPESCRIPT_PIN, BEHAVIOR_API_VERSION, M2_PINNED_MODULES, OUTPUT_SCAN_PATTERNS, OUTPUT_SCAN_ENGINE_LETTER, OUTPUT_SCAN_HOST_LETTERS, compilerToolchain, esbuildPinMatches } from './limits';
export type { PinnedModuleRef } from './types';
export {
  analyzeSourceGraph,
  posixResolve,
} from './scan';
export type { AnalyzeResult } from './scan';
export {
  canonicalContainerText,
  parseSourceGraphContainer,
} from './container';
export type { ContainerParseOk, ContainerParseResult } from './container';
export {
  compileBehavior,
  compileRecipe,
  compileRecipeDigest,
  createBehaviorCompiler,
  declarationDigestOf,
  manifestBytesOf,
  scanOutput,
} from './compile';
export { prepareBehavior, preparedSourceFrom } from './prepare';
// Phase 15.4: properties declared in code (`export const properties = { … }`).
export { labelOfKey, readCodeDeclaration } from './declare';
export type { CodeDeclarationResult } from './declare';
export type { BehaviorPrepareResult } from './prepare';
// Phase 19.0: visual scripts (behavior graph → TypeScript → the same compiler).
export { compileBehaviorGraph, diagnosticsWithNodes, generateGraphSource, graphProblemsFailure, GRAPH_SOURCE_BANNER } from './graph';
export type { BehaviorGraphCompileResult, GraphSourceOptions, GraphSourceResult } from './graph';
export { canonicalJsonText, sha256Hex, sha256HexOfText } from './canonical';
export type {
  BehaviorCompileFailure,
  BehaviorCompileInput,
  BehaviorCompileOptions,
  BehaviorCompileResult,
  BehaviorCompileSuccess,
  BehaviorCompiler,
  BehaviorCompilerLimits,
  BehaviorManifest,
  CompileDiagnostic,
  PreparedBehaviorSource,
  SourceGraphAnalysis,
  SourceGraphContainer,
  SourceGraphFile,
  SourceGraphParseResult,
} from './types';
