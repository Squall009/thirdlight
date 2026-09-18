/**
 * Packet 07 crash-test child runner (bundled with esbuild by the parent
 * test — plain node cannot import the workspace package's .ts entry).
 *
 * Modes (argv: <mode> <root> <projectId> <backendId> [requestId]
 * [expectedRevision]):
 *   claim         open (claim) the project, print HOLDING <pid>, wait for
 *                 SIGTERM (a second, live backend for ownership tests).
 *   apply         open, run a fresh setTransform, print the JSON result.
 *   crash-before  open, then run a setTransform whose renameFile is
 *                 replaced by SIGKILL — the process dies after the temp
 *                 file is written and BEFORE the atomic rename (the
 *                 pre-replacement crash: old state on disk, temp left
 *                 behind, no record, no ack).
 *   crash-after   open, then run a setTransform whose fsyncDir (the
 *                 scenes directory) is replaced by SIGKILL — the process
 *                 dies AFTER the rename (new bytes on disk) and BEFORE
 *                 the directory flush completes / the ack is sent.
 *
 * Every mode prints its JSON result (or error) as the last stdout line.
 */

import { openWorkspaceService, defaultWriteOps, type WriteOps } from '@thirdlight/workspace';

function killSelf(): void {
  // SIGKILL: an unrecoverable process death (no cleanup, no flushes).
  process.kill(process.pid, 'SIGKILL');
  // Unreachable; the process is gone.
  process.exit(137);
}

function targetIsEnvelope(path: string): boolean {
  return path.endsWith('main.json');
}
function dirIsScenes(path: string): boolean {
  return path.endsWith('scenes') || path.endsWith('scenes' + '/');
}

function crashBeforeOps(): WriteOps {
  const base = defaultWriteOps;
  return {
    ...base,
    renameFile: (from: string, to: string) => {
      if (targetIsEnvelope(to)) killSelf();
      base.renameFile(from, to);
    },
  };
}

function crashAfterOps(): WriteOps {
  const base = defaultWriteOps;
  return {
    ...base,
    fsyncDir: (d: string) => {
      if (dirIsScenes(d)) killSelf();
      base.fsyncDir(d);
    },
  };
}

function mutation(projectId: string, requestId: string, expectedRevision: number) {
  return {
    op: 'setTransform',
    projectId,
    expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
  };
}

async function main(): Promise<void> {
  const [mode, root, projectId, backendId, requestId, expectedRevision] = process.argv.slice(2);
  if (!mode || !root || !projectId || !backendId) {
    console.error(JSON.stringify({ ok: false, error: { code: 'usage', message: 'argv: mode root projectId backendId [requestId] [expectedRevision]' } }));
    process.exit(2);
  }
  const cfg = { root, backendId };
  let svc: ReturnType<typeof openWorkspaceService>;
  try {
    if (mode === 'crash-before') svc = openWorkspaceService({ ...cfg, ops: crashBeforeOps() });
    else if (mode === 'crash-after') svc = openWorkspaceService({ ...cfg, ops: crashAfterOps() });
    else svc = openWorkspaceService(cfg);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, openError: String(e) }));
    process.exit(1);
  }

  if (mode === 'claim') {
    // Wait a beat so the process start time is strictly before the
    // claim's openedAt (openedAt is second-truncated: a start within the
    // same second as the claim would look like pid reuse).
    await new Promise((r) => setTimeout(r, 1200));
    const q = svc.query({ op: 'queryProject', projectId }) as { ok: boolean };
    // The open (and its claim) happened during the query. Report and hold.
    console.log(JSON.stringify({ ok: q.ok, holding: true, pid: process.pid, backendId }));
    const onTerm = (): void => {
      clearInterval(keepAlive);
      try {
        svc.dispose();
      } catch {
        // exiting anyway
      }
      process.exit(0);
    };
    // A signal handler alone does not keep node's event loop alive — an
    // idle keep-alive timer holds the process open until it is signaled.
    const keepAlive = setInterval(() => {
      // alive
    }, 60000);
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onTerm);
    return; // wait
  }

  const r = svc.runCommand(mutation(projectId, requestId ?? 'req-0', Number(expectedRevision ?? 5)));
  console.log(JSON.stringify(r));
  svc.dispose();
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, crash: String(e) }));
  process.exit(1);
});