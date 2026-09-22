/**
 * Packet 60 — the M3 export determinism + preview/export parity
 * (export.md §7; delivery.md §2.4 "one capture, one read" + C35-5).
 *
 *   1. **Determinism:** two exports of the same captured state (a fixed wall
 *      clock) into two DIFFERENT output trees are byte-identical — the accepted
 *      timestamps (`capturedAt`/`exportedAt`) are the only time-dependent bytes
 *      and the `buildId` is re-derived from the manifest content (stable for the
 *      same content), so a fixed clock makes the outputs identical.
 *   2. **Preview/export parity:** the M3 EXPORT manifest and the v3 PLAY
 *      manifest for the same captured state are the SAME build — identical
 *      `buildId`/`settingsDigest`/`contentDigest`/`sceneDigest` — because both
 *      are derived by the SAME shared closure builder (`buildContentClosureM3`)
 *      from the SAME single captured read. The resolved six-key `settings`
 *      reach BOTH the export host and the preview host (C35-5).
 *
 * The real-browser standalone playthrough (independent static server under a
 * non-root prefix, backend stopped/unreachable, keyboard/gamepad/audio +
 * recorded network) is the owner-run procedure — UNVERIFIED in-container
 * (tests/browser/m3-export, packet-38 baseline §1).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContentClosureM3, exportProjectM3, type ExportContext, type ExportFs } from '@thirdlight/exporter';
import { buildPlayContentM3 } from '../../../packages/backend/src/play-m3';
import type { WorkspaceService } from '@thirdlight/workspace';
import { fakeService, syntheticV3 } from '../m3-builds/helpers';

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const M3_BOOTSTRAP = join(REPO_ROOT, 'packages/exporter', 'src', 'export-bootstrap-m3.ts');

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

let exportRootA = '';
let exportRootB = '';
let captured: { scene: unknown; content: unknown; revision: number };
let blobs: Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>;

function ctxFor(exportRoot: string): ExportContext {
  return {
    projectId: 'm3det',
    service: fakeService({ blobs }) as unknown as WorkspaceService,
    fs: realFs(),
    exportRoot,
    repoRoot: REPO_ROOT,
    authoringRoot: join(exportRoot, 'authoring'),
    authoringOrigin: 'http://authoring.invalid:3000',
    previewOrigin: 'http://preview.invalid:3001',
    tokenValues: ['secret-token-value-123'],
    bootstrapEntry: join(REPO_ROOT, 'packages/exporter/src/export-bootstrap.ts'),
    threePackageJson: join(REPO_ROOT, 'node_modules/three/package.json'),
    typescriptPackageJson: join(REPO_ROOT, 'node_modules/typescript/package.json'),
    lockfile: join(REPO_ROOT, 'package-lock.json'),
    m3BootstrapEntry: M3_BOOTSTRAP,
    compiler: { pinnedModules: {}, compile: async () => ({ ok: false, reason: 'no behaviors in the M3 closure' }) } as never,
    now: () => 1_700_000_000_000, // a fixed clock → deterministic capturedAt/exportedAt
  } as ExportContext;
}

function listFiles(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (existsSync(p) && statSync(p).isDirectory()) {
        walk(p, rel);
      } else {
        out.set(rel, new Uint8Array(readFileSync(p)));
      }
    }
  };
  walk(dir, '');
  return out;
}

beforeAll(() => {
  exportRootA = mkdtempSync(join(tmpdir(), 'tl-m3-det-a-'));
  exportRootB = mkdtempSync(join(tmpdir(), 'tl-m3-det-b-'));
  // The export resolver realpaths the authoring root (a forbidden target), so
  // it must exist.
  mkdirSync(join(exportRootA, 'authoring'), { recursive: true });
  mkdirSync(join(exportRootB, 'authoring'), { recursive: true });
  const env = syntheticV3();
  captured = { scene: env.scene, content: env.content, revision: 1 };
  blobs = env.blobs;
});

afterAll(() => {
  rmSync(exportRootA, { recursive: true, force: true });
  rmSync(exportRootB, { recursive: true, force: true });
});

describe('M3 export determinism + preview/export parity (packet 60)', () => {
  it('two exports of the same captured state (fixed clock) into different trees are byte-identical', async () => {
    const resA = await exportProjectM3(ctxFor(exportRootA), captured, M3_BOOTSTRAP, ctxFor(exportRootA).compiler as never);
    expect(resA.ok).toBe(true);
    if (!resA.ok) return;
    const resB = await exportProjectM3(ctxFor(exportRootB), captured, M3_BOOTSTRAP, ctxFor(exportRootB).compiler as never);
    expect(resB.ok).toBe(true);
    if (!resB.ok) return;

    const treeA = listFiles(join(exportRootA, resA.outputDir));
    const treeB = listFiles(join(exportRootB, resB.outputDir));

    // The same file set, byte-identical (fixed clock ⇒ identical capturedAt/
    // exportedAt; buildId re-derived from identical content ⇒ identical).
    const namesA = [...treeA.keys()].sort();
    const namesB = [...treeB.keys()].sort();
    expect(namesB).toEqual(namesA);
    for (const name of namesA) {
      expect(Buffer.from(treeB.get(name)!.buffer).equals(Buffer.from(treeA.get(name)!.buffer)), `byte mismatch: ${name}`).toBe(true);
    }
    // The core artifacts are present.
    for (const name of ['index.html', 'js/main.js', 'manifest.json', 'scene.json', 'meta.json']) {
      expect(namesA.includes(name), `missing ${name}`).toBe(true);
    }
  }, 120_000);

  it('the M3 EXPORT manifest and the v3 PLAY manifest for the same capture are the SAME build (parity)', async () => {
    const service = fakeService({ blobs }) as unknown as WorkspaceService;

    // The PLAY closure (packet 59) — the same shared builder.
    const play = await buildPlayContentM3({
      service,
      compiler: {} as never,
      projectId: 'm3parity',
      revision: 1,
      capturedAt: '2026-09-21T00:00:00Z',
      scene: captured.scene,
      content: captured.content,
      gameBundle: new Uint8Array([0x66, 0x75, 0x6e, 0x63]),
    });
    expect(play.ok).toBe(true);
    if (!play.ok) return;

    // The EXPORT closure — the same shared builder, same input.
    const exportClosure = await buildContentClosureM3({
      service,
      compiler: {} as never,
      projectId: 'm3parity',
      revision: 1,
      capturedAt: '2026-09-21T00:00:00Z',
      scene: captured.scene,
      content: captured.content,
    });
    expect(exportClosure.ok).toBe(true);
    if (!exportClosure.ok) return;

    const p = play.built.manifest;
    const e = exportClosure.closure.manifest;
    // SAME build identity for the same capture (one capture, one read).
    expect(e.buildId).toBe(p.buildId);
    expect(e.sceneDigest).toBe(p.sceneDigest);
    expect(e.contentDigest).toBe(p.contentDigest);
    expect(e.settingsDigest).toBe(p.settingsDigest);
    // The resolved six-key settings reach BOTH hosts (C35-5): the manifest's
    // settings block is the resolved registry map, hash-bound by settingsDigest.
    const settingsKeys = Object.keys(e.settings);
    expect(settingsKeys).toHaveLength(6);
    expect(e.settingsDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});