/**
 * Packet 07 group E1 — ownership claim-file crash/barrier child runner
 * (bundled with esbuild by the parent test — plain node cannot import the
 * workspace package's .ts entry; the same pattern as
 * tests/crash/child.ts).
 *
 * Modes (argv: <mode> <root> <projectId> <backendId> [gateFile]
 * [baseRevision] [entityId]):
 *   contend-open     wait for the gate file, then open (claim) the project.
 *                    On success: two fresh mutations (baseRevision → +1 →
 *                    +2; the second proves the claim did not flap), print
 *                    the summary JSON, and HOLD until SIGTERM (the winner
 *                    stays a live writer for the parent's on-disk asserts).
 *                    On open failure: still attempt one mutation (the
 *                    end-to-end refusal) and print the summary.
 *   contend-takeover wait for the gate file, then takeoverWorkspace (the
 *                    explicit §6.4 stale-owner recovery); the same
 *                    mutation/hold behavior.
 *   claim-hold       open (claim) the project, print READY, and hold
 *                    until the parent kills the process (a second, live
 *                    backend for ownership tests; SIGKILLed for the
 *                    stale-claim scenario).
 *   crash-claim      [gateFile] carries the crash POINT (before-stamp |
 *                    after-stamp | mid-record): open with a WriteOps fault
 *                    seam that SIGKILLs the process at that point of the
 *                    claim sequence. If the hook never fires (the old
 *                    rename-based primitive has no claim-file window), the
 *                    child prints {hooked:false} and exits 1.
 *
 * Every mode prints its JSON result (or error) as the last stdout line.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { openWorkspaceService, defaultWriteOps, type WriteOps } from '@thirdlight/workspace';

function killSelf(): void {
  // SIGKILL: an unrecoverable process death (no cleanup, no flushes).
  process.kill(process.pid, 'SIGKILL');
  // Unreachable; the process is gone.
  process.exit(137);
}

function isClaimFile(p: string): boolean {
  return basename(p).startsWith('claim-');
}
function isRecordTemp(p: string): boolean {
  return basename(p).startsWith('.ownership.json.tmp-');
}
function isRecordTarget(p: string): boolean {
  return basename(p) === 'ownership.json';
}

function crashOps(point: string): WriteOps {
  const base = defaultWriteOps;
  if (point === 'before-stamp') {
    // Kill AFTER the exclusive claim-file open lands, BEFORE the content
    // stamp: the orphan claim file is empty.
    return {
      ...base,
      openTempFile: (p: string): number => {
        if (isClaimFile(p)) {
          const fd = base.openTempFile(p);
          killSelf();
        }
        return base.openTempFile(p);
      },
    };
  }
  if (point === 'after-stamp') {
    // Kill BEFORE the record W starts (the record temp never exists): the
    // claim file carries the child's stamp with a dead pid.
    return {
      ...base,
      openTempFile: (p: string): number => {
        if (isRecordTemp(p)) killSelf();
        return base.openTempFile(p);
      },
    };
  }
  // mid-record: kill AFTER the record temp is fully written, BEFORE the
  // atomic rename: the record is absent (or stale), a temp is left behind.
  return {
    ...base,
    renameFile: (from: string, to: string): void => {
      if (isRecordTarget(to)) killSelf();
      base.renameFile(from, to);
    },
  };
}

function mutation(projectId: string, requestId: string, expectedRevision: number, position: [number, number, number], entityId: string) {
  return {
    op: 'setTransform',
    projectId,
    expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: 'pi-harness' },
    args: { entityId, transform: { position } },
  };
}

/** Syntactically valid requestIds (commands.md §6: req- + 32 hex). */
const REQ_W1 = 'req-00000000000000000000000000000001';
const REQ_W2 = 'req-00000000000000000000000000000002';
const REQ_L1 = 'req-000000000000000000000000000000ff';

async function waitForGate(gateFile: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (existsSync(gateFile)) return;
    if (Date.now() > deadline) throw new Error(`gate timeout (${gateFile})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<void> {
  const [mode, root, projectId, backendId, gateFile, baseRevision, entityId] = process.argv.slice(2);
  if (!mode || !root || !projectId || !backendId) {
    console.error(JSON.stringify({ ok: false, error: { code: 'usage', message: 'argv: mode root projectId backendId [gateFile] [baseRevision] [entityId]' } }));
    process.exit(2);
  }
  const baseRev = Number(baseRevision ?? 5);
  const entity = entityId ?? 'box-0001';

  if (mode === 'crash-claim') {
    const point = gateFile;
    if (point !== 'before-stamp' && point !== 'after-stamp' && point !== 'mid-record') {
      console.error(JSON.stringify({ ok: false, error: { code: 'usage', message: 'crash-claim point: before-stamp | after-stamp | mid-record' } }));
      process.exit(2);
    }
    const svc = openWorkspaceService({ root, backendId, ops: crashOps(point) });
    // The open (and its claim) runs synchronously inside the query; the
    // fault seam SIGKILLs the process at the gated point. If the hook
    // never fires, report it and exit non-zero.
    try {
      svc.query({ op: 'queryProject', projectId });
    } catch {
      // the seam may have interrupted the pipeline; the death is what
      // matters — fall through to the not-hooked report
    }
    console.log(JSON.stringify({ hooked: false, pid: process.pid }));
    svc.dispose();
    process.exit(1);
  }

  if (mode === 'claim-hold') {
    const svc = openWorkspaceService({ root, backendId });
    // Wait a beat so the process start time is strictly before the
    // claim's openedAt (openedAt is second-truncated: a start within the
    // same second as the claim would look like pid reuse).
    await new Promise((r) => setTimeout(r, 1200));
    const q = svc.query({ op: 'queryProject', projectId }) as { ok: boolean };
    console.log(JSON.stringify({ ready: true, pid: process.pid, holding: q.ok }));
    // Hold until the parent kills the process (SIGKILL for the stale
    // scenario; SIGTERM disposes cleanly).
    const keepAlive = setInterval(() => {
      // alive
    }, 60000);
    const onTerm = (): void => {
      clearInterval(keepAlive);
      try {
        svc.dispose();
      } catch {
        // exiting anyway
      }
      process.exit(0);
    };
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onTerm);
    return;
  }

  const svc = openWorkspaceService({ root, backendId });
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
  // Wait a beat so the process start time is strictly before the claim's
  // openedAt (openedAt is second-truncated: a start within the same second
  // as the claim would look like pid reuse).
  await new Promise((r) => setTimeout(r, 1200));
  if (gateFile === undefined) throw new Error('contend modes require a gate file');
  await waitForGate(gateFile, 30000);

  let openOk: boolean;
  let openResult: unknown = null;
  let m1: unknown = null;
  let m2: unknown = null;
  if (mode === 'contend-open') {
    const q = svc.query({ op: 'queryProject', projectId });
    openResult = q;
    openOk = (q as { ok: boolean }).ok;
  } else if (mode === 'contend-takeover') {
    const t = svc.takeoverWorkspace(projectId);
    openResult = t;
    openOk = t.ok;
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  if (openOk) {
    // Two DIFFERENT transforms: the second must actually change the scene
    // (an identical repeat would be a no_change, not a flap check).
    m1 = svc.runCommand(mutation(projectId, REQ_W1, baseRev, [1, 0, 0], entity));
    m2 = svc.runCommand(mutation(projectId, REQ_W2, baseRev + 1, [2, 0, 0], entity));
  } else {
    // The loser: a mutation issued from the loser is refused end-to-end.
    m1 = svc.runCommand(mutation(projectId, REQ_L1, baseRev, [1, 0, 0], entity));
  }
  console.log(JSON.stringify({ done: true, pid: process.pid, openOk, openResult, m1, m2 }));

  // Hold (the winner stays a live writer until the parent SIGTERMs it).
  const keepAlive = setInterval(() => {
    // alive
  }, 60000);
  const onTerm = (): void => {
    clearInterval(keepAlive);
    try {
      svc.dispose();
    } catch {
      // exiting anyway
    }
    process.exit(0);
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, crash: String(e) }));
  process.exit(1);
});