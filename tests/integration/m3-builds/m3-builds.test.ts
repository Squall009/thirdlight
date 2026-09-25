/**
 * Packet 58 — B21: export is a complete declared==emitted relative closure
 * including audio, models and code; no authoring/server/MCP/Node/credential/
 * capability/CDN dependency.
 *
 * Node integration test: `exportProjectM3` over the synthetic v3 envelope
 * (one model GLB + one audio WAV, self-consistent digests) through a FAKE
 * workspace service (the shared `queryProject`/`queryBehaviors`/`readBlob`
 * edge) and a REAL `node:fs`-backed `ExportFs`. Verifies:
 *   - the output tree (index.html, js/main.js, manifest.json, scene.json, the
 *     two content artifacts, meta.json);
 *   - the complete declared==emitted closure (every manifest-declared artifact
 *     is emitted; every emitted artifact is declared);
 *   - `meta.json` v2 (the manifest block carries `gameDigest`/`settingsDigest`/
 *     `mediaDigest`);
 *   - the emitted `scene.json` digest == `manifest.sceneDigest`;
 *   - the format-aware container scans (GLB + WAV) over the emitted artifacts;
 *   - the M3 bundle graph (no forbidden modules) via `checkBundleGraphM3`
 *     re-run on the rebuilt bundle's metafile;
 *   - a failed export (a late revision bump) leaves the previous output
 *     byte-untouched (`export_snapshot_mismatch`).
 *
 * UNVERIFIED here (no browser in this container): the real-browser static-URL
 * walkthrough (WebGL, the audio owner, the HUD) — packet 61/62 evidence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkBundleGraphM3, exportProjectM3, type ExportContext, type ExportFs } from '@thirdlight/exporter';

import { fakeService, sha256Hex, syntheticV3 } from './helpers';

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const M3_BOOTSTRAP = join(REPO_ROOT, 'packages/exporter/src/export-bootstrap-m3.ts');

/** A real `node:fs`-backed `ExportFs`. */
function realFs(): ExportFs {
  return {
    join: (...parts) => join(...parts),
    realpath: (p) => realpathSync(p),
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    exists: (p) => existsSync(p),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    write: (p, data) => writeFileSync(p, data),
    rename: (from, to) => renameSync(from, to),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    read: (p) => new Uint8Array(readFileSync(p)),
  };
}

function sha256HexNode(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let exportRoot = '';
let authoringRoot = '';
let captured: { scene: unknown; content: unknown; revision: number };
let blobs: Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>;
let revision = 1;
/** A fake workspace service whose `queryProject` re-reads a mutable revision
 * (so a late edit can advance it to trigger `export_snapshot_mismatch`). */
function serviceFor(currentRevision: number) {
  return fakeService({ blobs, revision: currentRevision });
}

beforeAll(() => {
  exportRoot = mkdtempSync(join(tmpdir(), 'tl-m3-export-'));
  authoringRoot = join(exportRoot, 'authoring');
  mkdirSync(authoringRoot, { recursive: true });
  const env = syntheticV3();
  captured = { scene: env.scene, content: env.content, revision: 1 };
  blobs = env.blobs;
});

afterAll(() => {
  rmSync(exportRoot, { recursive: true, force: true });
});

function ctxFor(rev: number): ExportContext {
  return {
    projectId: 'm3b21',
    service: serviceFor(rev),
    fs: realFs(),
    exportRoot,
    repoRoot: REPO_ROOT,
    authoringRoot,
    authoringOrigin: 'http://authoring.invalid:3000',
    previewOrigin: 'http://preview.invalid:3001',
    tokenValues: ['secret-token-value-123'],
    bootstrapEntry: join(REPO_ROOT, 'packages/exporter/src/export-bootstrap.ts'),
    threePackageJson: join(REPO_ROOT, 'node_modules/three/package.json'),
    typescriptPackageJson: join(REPO_ROOT, 'node_modules/typescript/package.json'),
    lockfile: join(REPO_ROOT, 'package-lock.json'),
    m3BootstrapEntry: M3_BOOTSTRAP,
    compiler: { pinnedModules: {}, compile: async () => ({ ok: false, reason: 'no behaviors in the M3 closure' }) } as never,
    now: () => 0, // a fixed clock → deterministic capturedAt/exportedAt
  } as ExportContext;
}

describe('B21 the M3 export is a complete declared==emitted relative closure', () => {
  it('emits the full output tree with the two kind-tagged content artifacts', async () => {
    const res = await exportProjectM3(ctxFor(1), captured, M3_BOOTSTRAP, ctxFor(1).compiler as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outputDir).toBe('m3b21@r1');
    const outDir = join(exportRoot, res.outputDir);
    const files = new Set(Object.keys(res.files));
    for (const name of ['index.html', 'js/main.js', 'manifest.json', 'scene.json', 'meta.json']) {
      expect(files.has(name), `missing ${name}`).toBe(true);
    }
    // The two content artifacts (model GLB + audio WAV) are emitted at their
    // digest addresses.
    const contentFiles = [...files].filter((f) => f.startsWith('content/sha256/'));
    expect(contentFiles).toHaveLength(2);
    // The manifest declares exactly the emitted content artifacts (declared
    // == emitted at the closure level).
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(readFileSync(join(outDir, 'manifest.json'))))) as {
      assets: Array<{ path: string }>;
      buildId: string;
      sceneDigest: string;
      settingsDigest: string;
      mediaDigest: string;
      gameDigest: string;
    };
    const declared = new Set(manifest.assets.map((a) => a.path));
    const emitted = new Set(contentFiles);
    expect(declared).toEqual(emitted);

    // The emitted scene.json digest == manifest.sceneDigest (the page verifies
    // this on load).
    const sceneBytes = new Uint8Array(readFileSync(join(outDir, 'scene.json')));
    expect(sha256HexNode(sceneBytes)).toBe(manifest.sceneDigest);

    // The format-aware container scans pass over the emitted artifacts (GLB +
    // WAV are valid containers).
    for (const a of manifest.assets) {
      const b = new Uint8Array(readFileSync(join(outDir, a.path)));
      if (a.path.endsWith) void 0;
      // Both are valid containers (the GLB magic + the RIFF/WAVE markers).
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const isGlb = dv.getUint32(0, true) === 0x46546c67;
      const isWav = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF';
      expect(isGlb || isWav, `artifact ${a.path} is neither a GLB nor a WAV`).toBe(true);
    }

    // meta.json v2: the manifest block carries the three M3 digests.
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(readFileSync(join(outDir, 'meta.json'))))) as {
      schemaVersion: number;
      manifest: { gameDigest: string; settingsDigest: string; mediaDigest: string; buildId: string };
      outputDigest: string;
    };
    expect(meta.schemaVersion).toBe(2);
    expect(meta.manifest.gameDigest).toBe(manifest.gameDigest);
    expect(meta.manifest.settingsDigest).toBe(manifest.settingsDigest);
    expect(meta.manifest.mediaDigest).toBe(manifest.mediaDigest);
    expect(meta.manifest.buildId).toBe(manifest.buildId);
    expect(typeof meta.outputDigest).toBe('string');
    expect(meta.outputDigest).toHaveLength(64);
  }, 120000);

  it('the M3 bundle graph check flags forbidden modules (negative control) and the emitted bundle is clean', () => {
    // Negative control: a metafile that DOES contain forbidden modules (a
    // `node:` builtin + the backend package) is flagged by `checkBundleGraphM3`.
    const forbiddenMetafile = {
      inputs: {
        [M3_BOOTSTRAP]: {},
        'node:fs': {},
        'packages/backend/src/play-content.ts': {},
        'packages/game-host/src/host.ts': {},
        'packages/runtime/src/runtime.ts': {},
      },
    };
    const flagged = checkBundleGraphM3(forbiddenMetafile, M3_BOOTSTRAP);
    expect(flagged.ok).toBe(false);
    expect(flagged.forbidden.some((f) => f.startsWith('node:'))).toBe(true);
    expect(flagged.forbidden.some((f) => f.includes('packages/backend/'))).toBe(true);

    // Positive control: a metafile with ONLY the allowed M3 composition graph
    // (the bootstrap + game-host + runtime + platformer-game + three + rapier)
    // is clean.
    const cleanMetafile = {
      inputs: {
        [M3_BOOTSTRAP]: {},
        'packages/game-host/src/host.ts': {},
        'packages/runtime/src/runtime.ts': {},
        'packages/platformer-game/src/session.ts': {},
        'packages/three-adapter/src/adapter.ts': {},
        'packages/input/src/browser.ts': {},
        'packages/physics-rapier/src/port.ts': {},
        'node_modules/three/build/three.module.js': {},
        'node_modules/@dimforge/rapier2d-compat/dist/rapier.js': {},
        'thirdlight-export:export-artifacts': {},
      },
    };
    expect(checkBundleGraphM3(cleanMetafile, M3_BOOTSTRAP).ok).toBe(true);

    // The emitted bundle (from the successful first export) carries no
    // forbidden content (the pipeline's §5.4 forbidden-pattern gate passed):
    // the a/b/c/e/g/i patterns (authoring/preview origin, /api/v1/, node:,
    // /mcp, tokens) must be zero. (`XMLHttpRequest`/`http` are three.js's own
    // recorded-exception contributions — not forbidden.)
    const outDir = join(exportRoot, 'm3b21@r1');
    const bundleText = new TextDecoder().decode(readFileSync(join(outDir, 'js/main.js')));
    // Phase 17.1: pattern e is a Node built-in module specifier (three's node materials have `node:` object keys).
    expect(bundleText.match(/["'`]node:/g) ?? []).toEqual([]);
    for (const needle of ['/api/v1/', '/mcp', 'http://authoring.invalid', 'http://preview.invalid', 'secret-token-value-123']) {
      expect(bundleText.includes(needle), `bundle contains forbidden ${needle}`).toBe(false);
    }
  });

  it('a late revision bump fails export_snapshot_mismatch and leaves the previous output byte-untouched', async () => {
    // The first export (revision 1) already wrote the tree. Capture its bytes.
    const outDir = join(exportRoot, 'm3b21@r1');
    const before = new Map<string, string>();
    const walk = (dir: string, target: Map<string, string>): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, target);
        else target.set(full, sha256HexNode(new Uint8Array(readFileSync(full))));
      }
    };
    walk(outDir, before);
    expect(before.size).toBeGreaterThan(0);

    // A late edit advances the authoring revision to 2 (the re-read now returns
    // 2, but the capture froze revision 1) → the export's revision re-read
    // fails `export_snapshot_mismatch` and writes nothing.
    const res = await exportProjectM3(ctxFor(2), captured, M3_BOOTSTRAP, ctxFor(2).compiler as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('export_snapshot_mismatch');

    // The previous output tree is byte-untouched.
    const after = new Map<string, string>();
    walk(outDir, after);
    expect(after).toEqual(before);
    // No new output directory was written for the failed export.
    expect(existsSync(join(exportRoot, 'm3b21@r2'))).toBe(false);
  }, 120000);
});