/**
 * Ambient surface for `import.meta.glob` (the Vite/vitest transform), the
 * narrow form this package's test files use to read a source file as text:
 * the package is browser-only, may not import Node built-ins (the boundary
 * check applies to tests too) and the workspace has no `@types/node`.
 * Production code never calls it.
 */
interface ImportMeta {
  glob(pattern: string, options?: { eager?: boolean; query?: string; import?: string }): Record<string, unknown>;
}
