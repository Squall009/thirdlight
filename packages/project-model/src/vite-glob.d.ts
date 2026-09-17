/**
 * Ambient surface for `import.meta.glob` (Vite/vitest transform) — the
 * narrow form this package's test files use to read the contract fixture
 * files.
 *
 * Why: the project-model package is the zero-dependency leaf of the
 * node-side graph (dependencies.md §4.1: no project deps, no Node
 * builtins), and the boundary check (dependencies.md §5 check 1) enforces
 * that in every package source — test files included (the only exempted
 * test import is the approved runner, vitest). The workspace also has no
 * `@types/node` or Vite client types (dependencies.md §7 pin table — no
 * new dependency for this packet). So the tests read fixtures through the
 * Vite `import.meta.glob(..., { query: '?raw' })` transform (no import
 * statement, byte-exact text) and this declaration types exactly that
 * surface. Production code never calls `import.meta.glob`.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>;
}