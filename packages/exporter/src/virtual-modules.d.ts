/**
 * The simulation module specs the manifest names (export-bundle.ts
 * `modulesModuleSource`), in dependency order — the composition's spec table.
 */
declare module 'thirdlight:export-modules' {
  /** The runtime's `SimulationModuleSpec` values (typed by the importing entry; this file has no runtime edge). */
  export const moduleSpecs: readonly unknown[];
}
