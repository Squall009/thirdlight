/**
 * Ambient surface for `import.meta.glob` (the Vite/vitest transform) — the
 * narrow form this package's test files use to read the committed GLB fixture
 * bytes and the fixture index.
 *
 * Why: `asset-pipeline` is a pure leaf (dependencies.md — no Node
 * built-ins, no I/O), and the boundary check enforces that in every package
 * source, test files included (the only exempted test import is the approved
 * runner `vitest`). The workspace also has no `@types/node` or Vite client
 * types, and none is added for tests. Tests therefore read fixtures through
 * `import.meta.glob(..., { query: '?raw' })`
 * and this declaration types exactly that surface. Production code never
 * calls `import.meta.glob`.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>;
}
