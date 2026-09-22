/**
 * Ambient surface for `import.meta.glob` (the Vite/vitest transform) — the
 * narrow form this package's test files use to read the committed
 * `fixtures/m2/input/**` JSON.
 *
 * Why: `@thirdlight/input` is a browser-safe, Node-built-in-free package
 * (dependencies.md §4.1/§4.3 — the boundary check applies to test files too;
 * the only exempted test import is the approved runner `vitest`), and the
 * workspace has no `@types/node` (no new dependency for this packet). Tests
 * therefore read the fixture index and sequences through
 * `import.meta.glob(..., { query: '?raw' })`; production code never calls it.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ): Record<string, unknown>;
}
