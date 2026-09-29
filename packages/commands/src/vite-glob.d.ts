/**
 * Ambient surface for `import.meta.glob` (Vite/vitest transform) — the
 * narrow form this package's test files use to read the contract fixture
 * files.
 *
 * Why: the commands package's boundary rules forbid Node builtin imports in every package source — test
 * files included (the only exempted test import is the approved runner,
 * vitest). The workspace also has no `@types/node` or Vite client types
 * (no dependency beyond the pin table). So
 * the tests read fixtures through the Vite
 * `import.meta.glob(..., { query: '?raw' })` transform (no import
 * statement, byte-exact text) and this declaration types exactly that
 * surface. Production code never calls `import.meta.glob`.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>;
}