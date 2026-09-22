/**
 * Packet 46 crash-test child runner (bundled with esbuild by the parent —
 * plain node cannot import the workspace package's .ts entry).
 *
 * Modes (argv: <mode> <root> <projectId> <sourceProjectId> <destProjectId> <backendId>):
 *   v3-env-before       a v3 setGameConfig, SIGKILL before the envelope rename
 *   v3-env-after        a v3 setGameConfig, SIGKILL after the envelope rename
 *                       (before the directory flush / the ack)
 *   v3-ack              a v3 setGameConfig that completes (lost-ack parent test)
 *   mig-phase-<p>       migrateProjectCopyV3, SIGKILL right after the marker is
 *                       renamed to phase p (created|manifest|blobs|envelope)
 *   mig-before-envelope SIGKILL before the destination envelope rename
 *   mig-after-envelope  SIGKILL after the destination envelope rename
 *   stale-owner         open + query the v3 project (claim), then SIGKILL
 *
 * Every mode SIGKILLs itself from inside a WriteOps seam, so the process dies
 * with no cleanup, no flush and no ack. Nothing is printed on the crash path;
 * a step that fails before the crash prints JSON and exits 1.
 */

import { readFileSync } from 'node:fs';

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

/** SIGKILL right after `.thirdlight/migration.json` becomes `phase`. */
function killAfterMarkerPhase(phase: string): WriteOps {
  return {
    ...defaultWriteOps,
    renameFile: (from: string, to: string) => {
      defaultWriteOps.renameFile(from, to);
      if (!to.endsWith('migration.json')) return;
      try {
        const doc = JSON.parse(readFileSync(to, 'utf8')) as { phase?: unknown };
        if (doc.phase === phase) killSelf();
      } catch {
        // an unreadable marker is not the boundary we are looking for
      }
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
  const [mode, root, projectId, sourceId, destId, backendId] = process.argv.slice(2);
  if (!mode || !root || !projectId || !backendId) {
    console.error('usage: mode root projectId sourceProjectId destProjectId backendId');
    process.exit(2);
  }
  const envelopeAbs = `${root}/projects/${projectId}/scenes/main.json`;
  const destEnvelopeAbs = `${root}/projects/${destId}/scenes/main.json`;

  let svc: WorkspaceService;
  if (mode === 'v3-env-before' || mode === 'mig-before-envelope') {
    svc = openWorkspaceService({ ...OPEN, root, backendId, ops: killBeforeRename(mode === 'mig-before-envelope' ? destEnvelopeAbs : envelopeAbs) });
  } else if (mode === 'v3-env-after' || mode === 'mig-after-envelope') {
    svc = openWorkspaceService({ ...OPEN, root, backendId, ops: killAfterDirFlush((d) => d.endsWith('scenes')) });
  } else if (mode.startsWith('mig-phase-')) {
    svc = openWorkspaceService({ ...OPEN, root, backendId, ops: killAfterMarkerPhase(mode.slice('mig-phase-'.length)) });
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

  if (mode.startsWith('mig-')) {
    const res = svc.migrateProjectCopyV3(sourceId, destId);
    if (!res.ok) fail('migrateProjectCopyV3', res);
    console.log(JSON.stringify({ ok: true, unexpected: res }));
    process.exit(0);
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
