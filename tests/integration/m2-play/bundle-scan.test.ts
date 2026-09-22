/**
 * Packet 35 — format-aware bundle scans for the production play-preview bundle
 * (export.md §5.4/§5.4.1 + delivery §4.3/§5.4).
 *
 * The preview bundle is built here with the EXACT §5.3 pinned option set (the
 * same esbuild 0.28.2 the workspace build uses) and scanned as text; a
 * reference full-core `three@0.186.0` bundle is re-measured in the same run so
 * the §5.4.1 recorded-exception table is re-verified against the current
 * install before the real bundle is judged.
 *
 * Measured honestly: binding 4's literal "pattern d: exactly 3 + 0 in the
 * preview bundle" was written for the M1 preview, which fetched nothing; the
 * M2 preview loads the manifest + declared artifacts through the locator
 * (delivery §4.3 explicitly permits exactly those reads). The scan therefore
 * asserts the recorded baseline + the loader row + the counted preview fetch
 * call sites, and the semantic hard negatives (no token/origin/API URL).
 * Recorded as contract-change request C35-6.
 */
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PINNED = {
  bundle: true,
  platform: 'browser' as const,
  format: 'iife' as const,
  treeShaking: false,
  sourcemap: false,
  minify: false,
  write: false,
};

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** The §5.4 a–j patterns (text bytes only — GLB/WASM are container-validated). */
function scanText(text: string, tokenValues: readonly string[]): Record<string, number> {
  return {
    a: tokenValues.reduce((n, v) => n + count(text, v), 0),
    b: 0,
    c: count(text, '/api/v1/'),
    d: count(text, 'fetch('),
    e: count(text, 'node:'),
    f: count(text, '__dirname') + count(text, 'process.'),
    g: count(text, '/mcp'),
    h: count(text, 'http://') + count(text, 'https://') + count(text, 'file://'),
    i: 0,
    j: count(text, 'XMLHttpRequest') + count(text, 'WebSocket'),
  };
}

async function buildBundle(entry: { stdin?: { contents: string; resolveDir: string }; path?: string }, outfile: string): Promise<string> {
  const result = await build({
    ...PINNED,
    ...(entry.stdin !== undefined ? { stdin: entry.stdin } : { entryPoints: [entry.path as string] }),
    outfile,
  });
  const out = result.outputFiles?.[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return new TextDecoder().decode(out.contents);
}

describe('play-preview bundle scans (export.md §5.4/§5.4.1, delivery §4.3)', () => {
  it('re-verifies the §5.4.1 reference full-core three counts, then judges the real preview bundle', async () => {
    // Binding 3: a reference full-core three bundle re-scans to the table's counts.
    const reference = await buildBundle(
      { stdin: { contents: "import * as THREE from 'three';\nconsole.log(THREE.REVISION);\n", resolveDir: REPO } },
      join(REPO, 'dist/preview/.scan-reference.js'),
    );
    const refCounts = scanText(reference, []);
    expect(refCounts.d).toBe(3);
    expect(refCounts.f).toBe(3);
    expect(refCounts.h).toBe(26);
    expect(refCounts.j).toBe(3);
    expect(refCounts.a + refCounts.b + refCounts.c + refCounts.e + refCounts.g + refCounts.i).toBe(0);

    // The real preview bundle: the §5.3 pinned option set, the same entry the
    // workspace build script uses.
    const preview = await buildBundle({ path: join(REPO, 'packages/editor/src/preview/preview-bootstrap.ts') }, join(REPO, 'dist/preview/.scan-preview.js'));

    const CANARY_TOKEN = 'tl-canary-authoring-token-9f3c';
    const counts = scanText(preview, [CANARY_TOKEN]);
    // Hard negatives: no credential, no authoring API call, no Node leak.
    expect(counts.a).toBe(0);
    expect(preview).not.toContain(CANARY_TOKEN);
    expect(counts.c).toBe(0);
    expect(counts.e).toBe(0);
    expect(counts.g).toBe(0);

    // §5.4.1 GLTFLoader row: +12 `https://` over the core baseline (all inert
    // doc-comment links) and the loader's own identifier present.
    expect(counts.h).toBe(refCounts.h + 12);
    expect(preview).toContain('GLTFLoader');
    // The other recorded core counts are unchanged by the loader.
    expect(counts.f).toBe(refCounts.f);
    expect(counts.j).toBe(refCounts.j);
    expect(counts.d).toBeGreaterThanOrEqual(refCounts.d);
    // The preview's own engine-initiated reads are the counted source call sites
    // (manifest + one per declared asset path) — never a hard-coded URL — plus
    // ONE inert occurrence inside the pinned `@dimforge/rapier2d-compat` compat
    // loader (its `fetch(A2)` path is unreachable here: the WASM is inlined and
    // the port receives bytes). Recorded as C35-7 (the §5.4.1 table predates the
    // physics bundle and needs a Rapier row).
    const source = readFileSync(join(REPO, 'packages/editor/src/preview/preview-bootstrap.ts'), 'utf8');
    const ownFetchSites = count(source, 'fetch(');
    expect(ownFetchSites).toBe(2);
    expect(counts.d - refCounts.d).toBe(ownFetchSites + 1);
    // No absolute/remote fetch literal (every target is built from the locator root).
    expect(preview).not.toContain('fetch("http');
    expect(preview).not.toContain("fetch('http");
  }, 120_000);
});
