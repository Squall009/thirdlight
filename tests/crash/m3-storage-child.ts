/**
 * Packet 46 crash-test child runner (bundled with esbuild by the parent —
 * plain node cannot import the workspace package's .ts entry).
 *
 * The project is the committed v3 fixture, already upgraded in place to
 * storage v4 by the parent; a setGameConfig writes content.json alone.
 *
 * Modes (argv: <mode> <root> <projectId> <backendId>):
 *   v3-env-before       a setGameConfig, SIGKILL before the content.json rename
 *   v3-env-after        a setGameConfig, SIGKILL after the content.json rename
 *                       (the project directory flush, before the ack)
 *   v3-ack              a setGameConfig that completes (lost-ack parent test)
 *   stale-owner         open + query the project (claim), then SIGKILL
 *
 * Every mode SIGKILLs itself from inside a WriteOps seam, so the process dies
 * with no cleanup, no flush and no ack. Nothing is printed on the crash path;
 * a step that fails before the crash prints JSON and exits 1.
 */

import {
  defaultWriteOps,
  openWorkspaceService,
  type WorkspaceService,
  type WriteOps,
} from '@thirdlight/workspace';

function killSelf(): void {
  process.kill(process.pid, 'SIGKILL');
  process.exit(137);
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

const REQUEST_ID = 'req-' + 'e'.repeat(32);
const CREATED_AT = '2026-09-19T10:00:00Z';
const OPEN = { utcNow: () => CREATED_AT };

function editTitle() {
  return {
    op: 'setGameConfig',
    projectId: process.argv[4],
    expectedRevision: 3,
    requestId: REQUEST_ID,
    origin: { kind: 'mcp', clientId: 'pi-crash' },
    args: { game: { title: 'Crash edited' } },
  };
}

function main(): void {
  const [mode, root, projectId, backendId] = process.argv.slice(2);
  if (!mode || !root || !projectId || !backendId) {
    console.error('usage: mode root projectId backendId');
    process.exit(2);
  }
  const projectDirAbs = `${root}/projects/${projectId}`;
  const contentAbs = `${projectDirAbs}/content.json`;

  let svc: WorkspaceService;
  if (mode === 'v3-env-before') {
    svc = openWorkspaceService({ ...OPEN, root, backendId, ops: killBeforeRename(contentAbs) });
  } else if (mode === 'v3-env-after') {
    // content.json lives in the project directory itself: its W flushes that directory.
    svc = openWorkspaceService({ ...OPEN, root, backendId, ops: killAfterDirFlush((d) => d.replace(/\/+$/, '') === projectDirAbs) });
  } else if (mode === 'v3-ack' || mode === 'stale-owner') {
    svc = openWorkspaceService({ ...OPEN, root, backendId });
  } else {
    console.error('unknown mode');
    process.exit(2);
  }

  if (mode === 'stale-owner') {
    // Claim + load the project (ownership record written, session open), then
    // die with no cleanup: the parent must see a stale owner.
    const q = svc.query({ op: 'queryProject', projectId });
    if (!(q as { ok: boolean }).ok) fail('query', q);
    killSelf();
  }

  const r = svc.runCommand(editTitle());
  if (!r.ok) fail('setGameConfig', r);
  if (mode === 'v3-env-before' || mode === 'v3-env-after') {
    console.log(JSON.stringify({ ok: true, unexpected: r }));
    process.exit(0);
  }
  console.log(JSON.stringify({ ok: true, revision: r.revision, op: r.op }));
  process.exit(0);
}

main();
