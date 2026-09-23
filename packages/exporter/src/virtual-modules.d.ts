/**
 * The virtual module the export build generates in memory (esbuild plugin,
 * export-bundle.ts): the declared asset paths and their relative reader.
 */
declare module 'thirdlight:export-artifacts' {
  /** The manifest-declared asset artifact paths (relative to the output root). */
  export const assetPaths: readonly string[];
  /** The single relative reader for one declared asset path (null when undeclared). */
  export function readAsset(path: string, signal: AbortSignal | undefined): Promise<Response> | null;
}
