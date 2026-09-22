/**
 * Packet 23 crash-test child runner (bundled with esbuild by the parent test —
 * plain node cannot import the workspace package's .ts entry).
 *
 * Modes (argv: <mode> <root> <projectId> <backendId>):
 *   blob-before    stage + publishBlob, SIGKILL before the blob rename
 *   blob-after     stage + publishBlob, SIGKILL after the blob rename (before
 *                  the directory flush completes / the ack)
 *   env-before     v2 setTransform, SIGKILL before the envelope rename
 *   env-after      v2 setTransform, SIGKILL after the envelope rename
 *   publish-before blob published, then publishAsset, SIGKILL before the
 *                  envelope rename (the unreferenced-blob crash point)
 *   publish-after  blob published, then publishAsset, SIGKILL after the
 *                  envelope rename (before the ack; the durable-reference
 *                  crash point)
 *
 * Every mode SIGKILLs itself from inside a WriteOps seam, so the process dies
 * with no cleanup, no flushes and no ack. Nothing is printed on the crash
 * path; a step that fails before the crash prints a JSON error and exits 1.
 */

import { createHash } from 'node:crypto';
import {
  openWorkspaceService,
  defaultWriteOps,
  type WorkspaceService,
  type WriteOps,
} from '@thirdlight/workspace';

function killSelf(): void {
  process.kill(process.pid, 'SIGKILL');
  process.exit(137);
}

const FRESH_BYTES = new TextEncoder().encode('packet-23 crash-test fresh blob\n');

function directPath(root: string, projectId: string, rel: string): string {
  return `${root}/projects/${projectId}/${rel}`;
}

function killBeforeRename(target: string): WriteOps {
  return {
    ...defaultWriteOps,
    renameFile: (from: string, to: string) => {
      if (to === target) killSelf();
      defaultWriteOps.renameFile(from, to);
    },
  };
}

function killAfterDirFlush(pred: (dir: string) => boolean): WriteOps {
  return {
    ...defaultWriteOps,
    fsyncDir: (d: string) => {
      if (pred(d)) killSelf();
      defaultWriteOps.fsyncDir(d);
    },
  };
}

function fail(step: string, result: unknown): never {
  console.log(JSON.stringify({ ok: false, step, result }));
  process.exit(1);
}

const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = {
  nodes: 1,
  meshes: 1,
  primitives: 1,
  materials: 1,
  images: 0,
  textures: 0,
  vertices: 3,
  triangles: 1,
  animations: 0,
  animationChannels: 0,
  clipDurationMs: 0,
  decodedGeometryBytes: 36,
  decodedImageBytes: 0,
};

function main(): void {
  const [mode, root, projectId, backendId] = process.argv.slice(2);
  if (!mode || !root || !projectId || !backendId) {
    console.error('usage: mode root projectId backendId');
    process.exit(2);
  }
  const digest = createHash('sha256').update(FRESH_BYTES).digest('hex');
  const blobAbs = directPath(root, projectId, `sources/sha256/${digest}`);
  const envelopeAbs = directPath(root, projectId, 'scenes/main.json');

  let svc: WorkspaceService;
  if (mode === 'blob-before') {
    svc = openWorkspaceService({ root, backendId, ops: killBeforeRename(blobAbs) });
  } else if (mode === 'blob-after') {
    svc = openWorkspaceService({ root, backendId, ops: killAfterDirFlush((d) => d.includes('sources') && d.endsWith('sha256')) });
  } else if (mode === 'env-before' || mode === 'publish-before') {
    svc = openWorkspaceService({ root, backendId, ops: killBeforeRename(envelopeAbs) });
  } else if (mode === 'env-after' || mode === 'publish-after') {
    svc = openWorkspaceService({ root, backendId, ops: killAfterDirFlush((d) => d.endsWith('scenes')) });
  } else {
    console.error('unknown mode');
    process.exit(2);
  }

  if (mode === 'blob-before' || mode === 'blob-after') {
    const st = svc.stageContent(projectId, { stageId: 'stg-crash01', bytes: FRESH_BYTES });
    if (!st.ok) fail('stage', st);
    const pub = svc.publishBlob(projectId, { digest, byteLength: FRESH_BYTES.length, source: { kind: 'stage', stageId: 'stg-crash01' } });
    if (!pub.ok) fail('publishBlob', pub);
    console.log(JSON.stringify({ ok: true, unexpected: pub }));
    process.exit(0);
  }

  if (mode === 'publish-before' || mode === 'publish-after') {
    const st = svc.stageContent(projectId, { stageId: 'stg-crash02', bytes: FRESH_BYTES });
    if (!st.ok) fail('stage', st);
    const pub = svc.publishBlob(projectId, { digest, byteLength: FRESH_BYTES.length, source: { kind: 'stage', stageId: 'stg-crash02' } });
    if (!pub.ok) fail('publishBlob', pub);
    const r = svc.runCommand({
      op: 'publishAsset',
      projectId,
      expectedRevision: 3,
      requestId: 'req-' + 'c'.repeat(32),
      origin: { kind: 'mcp', clientId: 'pi' },
      args: {
        mode: 'create',
        assetId: 'asset-00000000000000ee',
        displayName: 'Crash',
        sourceDigest: digest,
        sourceByteLength: FRESH_BYTES.length,
        importRecipe: RECIPE,
        metrics: METRICS,
        importedAt: '2026-09-18T12:00:00Z',
      },
    });
    if (!r.ok) fail('publishAsset', r);
    console.log(JSON.stringify({ ok: true, unexpected: r }));
    process.exit(0);
  }

  // env-before / env-after: a plain v2 scene mutation (envelope replacement).
  const r = svc.runCommand({
    op: 'setTransform',
    projectId,
    expectedRevision: 3,
    requestId: 'req-' + 'd'.repeat(32),
    origin: { kind: 'mcp', clientId: 'pi' },
    args: { entityId: 'model-0001', transform: { position: [1, 0, 0] } },
  });
  if (!r.ok) fail('setTransform', r);
  console.log(JSON.stringify({ ok: true, unexpected: r }));
  process.exit(0);
}

main();
