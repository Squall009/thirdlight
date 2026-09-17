/**
 * Test-only fixture access for the project-model test suite (NOT part of
 * the package's public surface — not exported from index.ts, imported only
 * by .test.ts files).
 *
 * Fixture files are read through the Vite `import.meta.glob` `?raw`
 * transform (eager, raw text) because this package's boundary rules forbid
 * Node builtin imports in package sources (dependencies.md §4.1/§5 check
 * 1; the only exempted test import is vitest). Every fixture file under
 * `fixtures/project-model/` is valid UTF-8 (packet 01 verification), so
 * `TextEncoder` round-trips the text to the exact file bytes; the raw
 * text is what the strict byte parser is designed to consume.
 */

const RAW = import.meta.glob('../../../fixtures/project-model/**', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const PREFIX = '../../../fixtures/project-model/';

/** Raw UTF-8 text of `fixtures/project-model/<rel>`. */
export function fixtureText(rel: string): string {
  const key = `${PREFIX}${rel}`;
  const v = RAW[key];
  if (typeof v !== 'string') {
    throw new Error(
      `fixture not found: ${rel} (matched ${Object.keys(RAW).length} files; ` +
        `sample keys: ${Object.keys(RAW).slice(0, 3).join(', ')})`,
    );
  }
  return v;
}

/** Exact bytes of `fixtures/project-model/<rel>` (UTF-8, BOM-free fixtures). */
export function fixtureBytes(rel: string): Uint8Array {
  return new TextEncoder().encode(fixtureText(rel));
}

/** Constant-time-free plain byte equality (no Buffer dependency). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** UTF-8 decode helper (fatal: the test inputs are valid UTF-8). */
export function decodeUtf8(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}