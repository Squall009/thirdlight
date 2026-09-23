/**
 * 2026-09-18 review repair — group E3 (R8 + L1) regression tests:
 * liveness/ownership I/O errors are UNKNOWN, never dead/absent.
 *
 * Findings:
 *  - R8 (docs/reviews/2026-09-18-commits.md): (a) with an active owner,
 *    chmod 000 of the ownership file makes the bytes unreadable ⇒ null ⇒
 *    "absent" ⇒ a second identity's open OVERWRITES the live claim;
 *    (b) an inaccessible `<procRoot>/<pid>/` directory (stat EACCES) is
 *    read as "dead" ⇒ query reports `stale_ownership` and an explicit
 *    takeover succeeds while the real owner is alive; (c)
 *    fileExists-style existence checks swallow read errors and report
 *    them as "not exists".
 *  - L1 (orchestrator spot-check of group E1, docs/orchestration.md
 *    2026-09-18 — 6/12 deterministic proof): `openedAt` is
 *    second-truncated (`utcSecond`) while the pid-reuse check compared
 *    against the SUB-SECOND process start time, so a LIVE owner that
 *    started and claimed within the same wall-clock second was
 *    classified dead (`startMs > floor(claimSecond)` ⇒ "pid reuse").
 *
 * Contract (workspace.md §6.2, post-`dabfcff`): "Liveness rules
 * (conservative — ambiguity resolves to 'live')": `/proc/<pid>` absent ⇒
 * dead; a present entry with an unreadable/missing start time, an
 * unreadable cmdline, or ANY error reading `/proc` ⇒ unknown ⇒ treated
 * as live (reject; the operator investigates). §6.3: "A non-ENOENT
 * record read failure at the re-read is never treated as absence".
 * §11: `ownership_conflict` "carries `holder`, `null` when no parseable
 * owned record exists" — the refusal code for an unreadable record
 * (the contract specifies the refusal without a dedicated code, so the
 * existing `ownership_conflict` is reused; no new code).
 *
 * L1 boundary (per the orchestrator fix sketch; the record format is
 * UNCHANGED — second-precision `openedAt`): pid reuse is CONCLUSIVE only
 * when `startMs > openedAtMs + 1000` (a reused pid necessarily starts
 * after the true claim time C, and C < floor(C) + 1 s);
 * `startMs <= openedAtMs + 1000` ⇒ ambiguous ⇒ live.
 *
 * Mechanisms (documented):
 *  - R8a: REAL `chmod 000` on the ownership file / `.thirdlight`
 *    directory — the tests run unprivileged, so the reads get a REAL
 *    EACCES (the R8 repro). The owner's liveness is proven with the
 *    supported procRoot seam (`buildFakeProc`, live entry).
 *  - R8b: fake procRoot trees: (i) `<procRoot>/<pid>` dir chmod 000 ⇒
 *    the stat-file read gets EACCES (documented mechanism — the seam is
 *    a real directory tree, so a real chmod gives the real errno);
 *    (ii) procRoot pointed at a REGULAR FILE ⇒ the proc table is
 *    unreadable (ENOTDIR on every entry access); (iii) the proc entry
 *    dir present but the `stat` file MISSING ⇒ unknown, not dead;
 *    (iv) cmdline chmod 000 ⇒ unreadable cmdline; (v) absent entry ⇒
 *    the ENOENT death pin; (vi) absent procRoot ⇒ the proc table is
 *    unavailable — nothing is provable ⇒ unknown.
 *  - L1: deterministic fake `/proc/<pid>/stat` with btime-anchored
 *    start times inside/above the `openedAt` second (no timing, no
 *    sleep — `btime` in `<procRoot>/stat` is written from the same boot
 *    clock the liveness math uses).
 *
 * Real filesystem, disposable mkdtemp roots under /home/dadmin (ext4 —
 * /tmp is tmpfs). Never run against repo/user paths.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join, dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type QueryResult } from '@thirdlight/workspace';

import { evaluateLiveness } from './ownership';

// ---- paths / ids ---------------------------------------------------------------

const PROJECT = 'demo-0001';
const FIXTURES = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'fixtures',
  'commands',
);

const A_ID = 'tb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // fixture owner
const B_ID = 'tb-bbbb2222bbbb2222bbbb2222bbbb2222'; // the second identity
const A_PID = 5000; // the fixture owner's pid
const B_PID = 5150; // the second backend's pid
const MARKER = 'thirdlight';

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(), `tl07e3-${tag}-`));
  roots.push(root);
  return root;
}

function dropRoot(root: string): void {
  try {
    // 000-ed files/dirs would break the recursive delete: restore first.
    const tl = join(root, 'projects', PROJECT, '.thirdlight');
    try {
      chmodSync(tl, 0o755);
    } catch {
      // best effort
    }
    for (const name of ['ownership.json', 'claim-0', 'claim-1']) {
      try {
        chmodSync(join(tl, name), 0o644);
      } catch {
        // best effort
      }
    }
    const proc = join(root, 'proc');
    try {
      for (const d of defaultOps.listDir(proc)) {
        try {
          chmodSync(join(proc, d), 0o755);
        } catch {
          // best effort
        }
      }
    } catch {
      // no proc tree
    }
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort — the afterAll backstop retries
  }
}

// The ambient node:fs surface (node-ambient.d.ts) does not declare
// readdirSync for this package; the tests get directory listing from the
// shared default ops (the same public seam the service uses for listing).
import { defaultOps } from './write';

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- on-disk evidence ------------------------------------------------------------

const recPath = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight', 'ownership.json');
const claimPath = (root: string, e: number): string =>
  join(root, 'projects', PROJECT, '.thirdlight', `claim-${e}`);
const thirdlightDir = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight');

function fileExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Copy the scenario-09 fixture disk state (owner A, pid 5000, epoch 0,
 * claim-0 stamp included) into `<root>/projects/<PROJECT>`. */
function seedScenario09(root: string): void {
  const disk = join(FIXTURES, 'scenarios', '09-second-backend-ownership', 'disk-before');
  const dest = join(root, 'projects', PROJECT);
  mkdirSync(join(dest, 'scenes'), { recursive: true });
  mkdirSync(join(dest, '.thirdlight'), { recursive: true });
  writeFileSync(join(dest, 'project.json'), readFileSync(join(disk, 'project.json')));
  writeFileSync(join(dest, 'scenes', 'main.json'), readFileSync(join(disk, 'scenes', 'main.json')));
  writeFileSync(join(dest, '.thirdlight', 'ownership.json'), readFileSync(join(disk, '.thirdlight', 'ownership.json')));
  writeFileSync(join(dest, '.thirdlight', 'claim-0'), readFileSync(join(disk, '.thirdlight', 'claim-0')));
}

interface QueryErr {
  code: string;
  reason?: string;
  holder?: { backendId: string; pid: number; openedAt: string; lockEpoch: number; state: string } | null;
}

function queryErr(svc: ReturnType<typeof openWorkspaceService>): QueryErr | null {
  const q = svc.query({ op: 'queryProject', projectId: PROJECT }) as QueryResult;
  if (q.ok) return null;
  return q.error as unknown as QueryErr;
}

// ---- fake /proc tree builders (L1 + R8b unit cases) -------------------------------

/** Boot wall-clock seconds (the clock the fake start times are built against). */
function btimeSec(): number {
  return Math.floor((Date.now() - uptime() * 1000) / 1000);
}

/**
 * A fake proc entry: `<procRoot>/<pid>/{stat,cmdline}`. `startMs` is the
 * wall-clock ms (boot-anchored) at which the process "started": the stat
 * field 22 (starttime, jiffies = 10 ms) is derived from it, and
 * `<procRoot>/stat` carries the matching `btime`.
 */
function writeProcEntry(
  procRoot: string,
  pid: number,
  startMs: number,
  opts: { withStat?: boolean; withCmdline?: boolean; cmdlineMode?: number } = {},
): void {
  const { withStat = true, withCmdline = true, cmdlineMode = 0o644 } = opts;
  // One btime capture: the same value is written to `<procRoot>/stat` AND
  // used to derive the start ticks (no second rollover between the two).
  const btime = btimeSec();
  mkdirSync(procRoot, { recursive: true });
  writeFileSync(join(procRoot, 'stat'), `btime ${btime}\n`);
  mkdirSync(join(procRoot, String(pid)), { recursive: true });
  if (withStat) {
    const ticks = Math.round((startMs - btime * 1000) / 10);
    // `pid (comm) S <18 zero fields> starttime 0 0 0` — field 22 (1-based)
    // = rest[19] after splitting at the last ')'.
    const fields: string[] = [];
    for (let i = 0; i < 18; i++) fields.push('0');
    fields.push(String(ticks));
    writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (fake-${MARKER}) S ${fields.join(' ')} 0 0 0\n`);
  }
  if (withCmdline) {
    // argv[0] + NUL (the cmdline format); the NUL byte goes through the
    // string path (the ambient node:fs surface has no Buffer).
    writeFileSync(join(procRoot, String(pid), 'cmdline'), `${MARKER}-node\0`);
    if (cmdlineMode !== 0o644) chmodSync(join(procRoot, String(pid), 'cmdline'), cmdlineMode);
  }
}

/** The ISO second of `nowMs` (the record's `openedAt` format). */
function isoSecond(nowMs: number): string {
  return new Date(Math.floor(nowMs / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A `nowMs` whose second is strictly after boot (keeps start ticks ≥ 0). */
function currentSecondMs(): number {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  return (sec > btimeSec() ? sec : btimeSec() + 1) * 1000;
}

// =============================================================================
// T1 — R8a: an unreadable ownership record is NEVER "absent" (real EACCES)
// =============================================================================

describe('T1: R8a — real-permission unreadable ownership record (workspace.md §6.2/§6.3/§11)', () => {
  it('T1(a): owner live, claim file present, record chmod 000 ⇒ query AND explicit takeover refused (ownership_conflict, holder null); record + claim file byte-identical after restore', () => {
    const root = makeRoot('t1a');
    seedScenario09(root);
    const recBefore = readFileSync(recPath(root));
    const claimBefore = readFileSync(claimPath(root, 0));
    // The owner (pid 5000) is LIVE under the procRoot seam.
    const procRoot = join(root, 'proc');
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));

    chmodSync(recPath(root), 0o000);
    const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });

    // On-demand open (query): REFUSED — the record's state is unknown ⇒
    // the §6.2 conservative rule resolves it to live ⇒ no claim (a claim
    // would overwrite unknown bytes). §11 line 934: ownership_conflict
    // carries holder — strict null when no parseable owned record exists.
    const e = queryErr(b);
    expect(e).not.toBeNull();
    expect(e?.code).toBe('project_unavailable');
    expect(e?.reason).toBe('ownership_conflict');
    expect(e?.holder).toBeNull(); // holder: strict null on the wire (T5 pins it)

    // Explicit takeover: REFUSED the same way (no stale_ownership — the
    // record cannot be evaluated at all; only PROVEN death permits a
    // takeover, §6.4).
    const to = b.takeoverWorkspace(PROJECT);
    expect(to.ok).toBe(false);
    if (!to.ok) expect(to.error.code).toBe('ownership_conflict');

    // Nothing was written: restore and the original record (and claim
    // file) are byte-identical.
    chmodSync(recPath(root), 0o644);
    expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
    expect(bytesEqual(readFileSync(claimPath(root, 0)), claimBefore)).toBe(true);
    b.dispose();
    dropRoot(root);
  });

  it('T1(b): owner live, claim file ABSENT, record chmod 000 ⇒ the R8 overwrite repro: pre-fix the open overwrites the live claim; post-fix query AND takeover refused, record never overwritten', () => {
    const root = makeRoot('t1b');
    seedScenario09(root);
    const recBefore = readFileSync(recPath(root));
    // The claim file is absent (the R8 repro state — a pre-E1 owner, or a
    // removed token): with the record unreadable, the pre-fix open
    // evaluated the record as ABSENT and claimed over the live owner.
    unlinkSync(claimPath(root, 0));
    const procRoot = join(root, 'proc');
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));

    chmodSync(recPath(root), 0o000);
    const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });

    const e = queryErr(b);
    expect(e).not.toBeNull(); // pre-fix: e === null (the open SUCCEEDED)
    expect(e?.code).toBe('project_unavailable');
    expect(e?.reason).toBe('ownership_conflict');
    expect(e?.holder).toBeNull(); // holder: strict null on the wire (T5 pins it)

    const to = b.takeoverWorkspace(PROJECT);
    expect(to.ok).toBe(false); // pre-fix: the takeover SUCCEEDED
    if (!to.ok) expect(to.error.code).toBe('ownership_conflict');

    // The live claim was never overwritten (and nothing was written —
    // no claim file appeared, no temp residue).
    chmodSync(recPath(root), 0o644);
    expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
    expect(fileExists(claimPath(root, 0))).toBe(false);
    b.dispose();
    dropRoot(root);
  });

  it('T1(c): owner live, the .thirdlight DIR chmod 000 (EACCES from parent traversal) ⇒ query refused; record byte-identical after restore', () => {
    const root = makeRoot('t1c');
    seedScenario09(root);
    const recBefore = readFileSync(recPath(root));
    const procRoot = join(root, 'proc');
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));

    chmodSync(thirdlightDir(root), 0o000);
    const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });
    const e = queryErr(b);
    expect(e).not.toBeNull();
    expect(e?.code).toBe('project_unavailable');
    expect(e?.reason).toBe('ownership_conflict');
    expect(e?.holder).toBeNull(); // holder: strict null on the wire (T5 pins it)

    chmodSync(thirdlightDir(root), 0o755);
    expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
    b.dispose();
    dropRoot(root);
  });
});

// =============================================================================
// T2 — R8b: liveness I/O errors are unknown, never death (procRoot seam)
// =============================================================================

describe('T2: R8b — /proc I/O errors classify as unknown ⇒ live (workspace.md §6.2)', () => {
  it('T2(a): owner live, <procRoot>/<pid> chmod 000 ⇒ query reports ownership_conflict (NOT stale_ownership); explicit takeover REFUSED while the owner is alive; record untouched, no claim-1', () => {
    const root = makeRoot('t2a');
    seedScenario09(root);
    const recBefore = readFileSync(recPath(root));
    const procRoot = join(root, 'proc');
    // 5000 is live in the tree, then the entry dir is made unreadable.
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));
    chmodSync(join(procRoot, String(A_PID)), 0o000);

    const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });
    const e = queryErr(b);
    expect(e).not.toBeNull();
    expect(e?.code).toBe('project_unavailable');
    // Pre-fix: reason stale_ownership (stat EACCES read as dead).
    expect(e?.reason).toBe('ownership_conflict');
    // The record IS parseable (only /proc is unreadable): the holder is
    // the on-disk owner.
    expect(e?.holder?.pid).toBe(A_PID);

    // Explicit takeover while the real owner is alive: REFUSED.
    const to = b.takeoverWorkspace(PROJECT);
    expect(to.ok).toBe(false); // pre-fix: the takeover SUCCEEDED
    if (!to.ok) expect(to.error.code).toBe('ownership_conflict');

    // The record was not rewritten and no takeover claim file appeared.
    chmodSync(join(procRoot, String(A_PID)), 0o755);
    expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
    expect(fileExists(claimPath(root, 1))).toBe(false);
    b.dispose();
    dropRoot(root);
  });

  it('T2(b): <procRoot>/<pid> chmod 000 ⇒ evaluateLiveness is unknown (NOT dead)', () => {
    const root = makeRoot('t2b');
    const procRoot = join(root, 'proc');
    // The fixture's static openedAt (far in the future relative to the
    // host boot clock — the seam convention: the fake start time is
    // anchored to it, so the start ticks are a large positive number).
    const openedAt = '2026-09-17T09:00:00Z';
    writeProcEntry(procRoot, A_PID, Date.parse(openedAt) - 60_000);
    chmodSync(join(procRoot, String(A_PID)), 0o000);
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('unknown'); // pre-fix: 'dead'
    chmodSync(join(procRoot, String(A_PID)), 0o755);
    dropRoot(root);
  });

  it('T2(c): procRoot pointed at a regular file (proc table unreadable, ENOTDIR) ⇒ unknown (NOT dead)', () => {
    const root = makeRoot('t2c');
    const openedAt = '2026-09-17T09:00:00Z';
    const fileProc = join(root, 'not-a-dir');
    writeFileSync(fileProc, 'not a proc table\n');
    const lv = evaluateLiveness(A_PID, openedAt, fileProc, MARKER);
    expect(lv).toBe('unknown'); // pre-fix: 'dead'
    dropRoot(root);
  });

  it('T2(d): procRoot absent (proc table unavailable) ⇒ unknown (NOT dead — nothing is provable)', () => {
    const root = makeRoot('t2d');
    const openedAt = '2026-09-17T09:00:00Z';
    const lv = evaluateLiveness(A_PID, openedAt, join(root, 'does-not-exist'), MARKER);
    expect(lv).toBe('unknown'); // pre-fix: 'dead'
    dropRoot(root);
  });

  it('T2(e): proc entry present but the stat file MISSING ⇒ unknown (NOT dead — the entry means the pid is allocated)', () => {
    const root = makeRoot('t2e');
    const procRoot = join(root, 'proc');
    const openedAt = '2026-09-17T09:00:00Z';
    writeProcEntry(procRoot, A_PID, Date.parse(openedAt) - 60_000, { withStat: false });
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('unknown'); // pre-fix: 'dead' (statPathExists false)
    dropRoot(root);
  });

  it('T2(f): unreadable cmdline (chmod 000), entry + stat readable, started before openedAt ⇒ unknown (pin: already unknown pre-fix)', () => {
    const root = makeRoot('t2f');
    const procRoot = join(root, 'proc');
    const openedAt = '2026-09-17T09:00:00Z';
    writeProcEntry(procRoot, A_PID, Date.parse(openedAt) - 60_000, { cmdlineMode: 0o000 });
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('unknown');
    chmodSync(join(procRoot, String(A_PID), 'cmdline'), 0o644);
    dropRoot(root);
  });

  it('T2(g): proc entry ABSENT (ENOENT) ⇒ dead (pin: the only proven-dead-by-absence signal)', () => {
    const root = makeRoot('t2g');
    const procRoot = join(root, 'proc');
    const openedAt = '2026-09-17T09:00:00Z';
    writeProcEntry(procRoot, A_PID, Date.parse(openedAt) - 60_000);
    rmSync(join(procRoot, String(A_PID)), { recursive: true, force: true });
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('dead');
    dropRoot(root);
  });
});

// =============================================================================
// T3 — L1: the pid-reuse boundary (deterministic, no timing)
// =============================================================================

describe('T3: L1 — second-truncated openedAt makes pid reuse conclusive only past +1 s (workspace.md §6.2 "ambiguity resolves to live")', () => {
  /** The openedAt second and its ms value (guaranteed > boot). */
  function secondAnchor(): { openedAt: string; ms: number } {
    const ms = currentSecondMs();
    return { openedAt: isoSecond(ms), ms };
  }

  it('T3(a): owner start inside the SAME truncated second as openedAt (+0.5 s) ⇒ pre-fix dead (RED); post-fix LIVE (ambiguous)', () => {
    const root = makeRoot('t3a');
    const procRoot = join(root, 'proc');
    const { openedAt, ms } = secondAnchor();
    writeProcEntry(procRoot, A_PID, ms + 500); // startMs = openedAtMs + 500
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    // Pre-fix: startMs (S+500) > openedAtMs (S) ⇒ 'dead' — the L1
    // false-dead (the live owner started and claimed within the same
    // wall-clock second). Post-fix: S+500 <= S+1000 ⇒ ambiguous ⇒ the
    // cmdline marker match ⇒ live.
    expect(lv).toBe('live');
    dropRoot(root);
  });

  it('T3(b): owner start exactly at openedAt + 1 s (the boundary) ⇒ LIVE (ambiguous; the boundary is strict: conclusive requires strictly > +1 s)', () => {
    const root = makeRoot('t3b');
    const procRoot = join(root, 'proc');
    const { openedAt, ms } = secondAnchor();
    writeProcEntry(procRoot, A_PID, ms + 1000); // startMs == openedAtMs + 1000
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('live'); // pre-fix: 'dead'
    dropRoot(root);
  });

  it('T3(c): owner start strictly after openedAt + 1 s (+1.5 s) ⇒ dead (conclusive pid reuse stays conclusive)', () => {
    const root = makeRoot('t3c');
    const procRoot = join(root, 'proc');
    const { openedAt, ms } = secondAnchor();
    writeProcEntry(procRoot, A_PID, ms + 1500); // startMs = openedAtMs + 1500
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('dead');
    dropRoot(root);
  });

  it('T3(d): owner start 1 s BEFORE openedAt ⇒ live (pin: started before the claim, marker match)', () => {
    const root = makeRoot('t3d');
    const procRoot = join(root, 'proc');
    const { openedAt, ms } = secondAnchor();
    writeProcEntry(procRoot, A_PID, ms - 1000); // startMs = openedAtMs - 1000
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('live');
    dropRoot(root);
  });

  it('T3(e): proc table present but the proc entry ABSENT (ENOENT) ⇒ dead (pin: ENOENT remains the death-by-absence signal)', () => {
    const root = makeRoot('t3e');
    const procRoot = join(root, 'proc');
    const { openedAt } = secondAnchor();
    // The proc table (with its btime) exists; the entry does not.
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(join(procRoot, 'stat'), `btime ${btimeSec()}\n`);
    const lv = evaluateLiveness(A_PID, openedAt, procRoot, MARKER);
    expect(lv).toBe('dead');
    dropRoot(root);
  });

  it('T3(f): service level — record openedAt = current second: owner start +0.5 s ⇒ query ownership_conflict (pre-fix stale_ownership); owner start +1.5 s ⇒ stale_ownership (pin)', () => {
    // Case 1: the L1 window (same truncated second).
    {
      const root = makeRoot('t3f1');
      seedScenario09(root);
      // Rewrite the record + claim file with a CURRENT-second openedAt
      // (the L1 shape: the owner claimed this second; the fixture's
      // static date would never exercise the window).
      const now = currentSecondMs();
      const openedAt = isoSecond(now);
      writeFileSync(
        recPath(root),
        JSON.stringify(
          { storageVersion: 1, state: 'owned', backendId: A_ID, pid: A_PID, openedAt, lockEpoch: 0 },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        claimPath(root, 0),
        JSON.stringify({ backendId: A_ID, pid: A_PID, openedAt }, null, 2) + '\n',
      );
      const procRoot = join(root, 'proc');
      writeProcEntry(procRoot, A_PID, now + 500); // startMs = openedAtMs + 500

      const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });
      const recBefore = readFileSync(recPath(root));
      const e = queryErr(b);
      expect(e).not.toBeNull();
      // Pre-fix: stale_ownership (the false-dead L1); post-fix:
      // ownership_conflict (ambiguous ⇒ live; the holder is parseable).
      expect(e?.reason).toBe('ownership_conflict');
      expect(e?.holder?.pid).toBe(A_PID);
      const to = b.takeoverWorkspace(PROJECT);
      expect(to.ok).toBe(false);
      if (!to.ok) expect(to.error.code).toBe('ownership_conflict');
      // The live claim was not rewritten (and no takeover claim-1).
      expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
      expect(fileExists(claimPath(root, 1))).toBe(false);
      b.dispose();
      dropRoot(root);
    }
    // Case 2: conclusive pid reuse (+1.5 s) is dead: reclaimed.
    {
      const root = makeRoot('t3f2');
      seedScenario09(root);
      const now = currentSecondMs();
      const openedAt = isoSecond(now);
      writeFileSync(
        recPath(root),
        JSON.stringify(
          { storageVersion: 1, state: 'owned', backendId: A_ID, pid: A_PID, openedAt, lockEpoch: 0 },
          null,
          2,
        ) + '\n',
      );
      writeFileSync(
        claimPath(root, 0),
        JSON.stringify({ backendId: A_ID, pid: A_PID, openedAt }, null, 2) + '\n',
      );
      const procRoot = join(root, 'proc');
      writeProcEntry(procRoot, A_PID, now + 1500); // startMs = openedAtMs + 1500

      const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });
      // Conclusive reuse ⇒ dead ⇒ reclaimed automatically.
      expect(queryErr(b)).toBeNull();
      b.dispose();
      dropRoot(root);
    }
  });
});

// =============================================================================
// T4 — R8a/R8c: the scan preserves absent vs unreadable (unknown ⇒ never
// reported stale; a proven-dead readable record still is)
// =============================================================================

describe('T4: scan — an unreadable ownership record is never reported stale (workspace.md §6.2/§10)', () => {
  it('T4: record chmod 000 ⇒ no staleOwnership flag (unknown is not proven death); restored + owner dead in the seam ⇒ staleOwnership flag', () => {
    const root = makeRoot('t4');
    seedScenario09(root);
    const recBefore = readFileSync(recPath(root));
    // The owner pid is ABSENT in the seam (dead) — the record must be
    // READABLE for that to be provable.
    const procRoot = join(root, 'proc');
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));
    rmSync(join(procRoot, String(A_PID)), { recursive: true, force: true });

    chmodSync(recPath(root), 0o000);
    const svc = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });
    let report = svc.scan();
    let entry = report.entries.find((x) => x.projectId === PROJECT);
    expect(entry).toBeDefined();
    expect(entry?.staleOwnership).toBeUndefined(); // unreadable ⇒ unknown ⇒ never "stale"

    // Restore: the SAME dead owner is now provable ⇒ the flag appears
    // (the distinction is preserved in both directions).
    chmodSync(recPath(root), 0o644);
    report = svc.scan();
    entry = report.entries.find((x) => x.projectId === PROJECT);
    expect(entry?.staleOwnership).toBe(true);
    expect(bytesEqual(readFileSync(recPath(root)), recBefore)).toBe(true);
    svc.dispose();
    dropRoot(root);
  });
});

// =============================================================================
// T5 — residual (spot-check round 2): unreadable record ⇒ `holder` is a
// STRICT `null` on both refusal surfaces (workspace.md §11 line 934:
// `ownership_conflict` "carries `holder`, `null` when no parseable owned
// record exists")
// =============================================================================

describe('T5: §11 line 934 — unreadable-record refusal carries holder: strict null (spot-check round 2)', () => {
  it('T5: owner live, record chmod 000 ⇒ the query envelope AND the direct takeover error both carry the `holder` field as strict null (pre-fix: field omitted ⇒ undefined)', () => {
    const root = makeRoot('t5');
    seedScenario09(root);
    // The owner (pid 5000) is LIVE under the procRoot seam; the record is
    // made unreadable (the R8a repro — same as T1(a)).
    const procRoot = join(root, 'proc');
    writeProcEntry(procRoot, A_PID, Date.parse('2026-09-17T08:59:00Z'));
    chmodSync(recPath(root), 0o000);
    const b = openWorkspaceService({ root, backendId: B_ID, pid: B_PID, procRoot });

    // Surface 1 — the query envelope `project_unavailable {
    // reason: "ownership_conflict" }`: the `holder` field is PRESENT and
    // strict null (parity with the parseable case, where the envelope
    // carries the holder object — pinned by T2(a): `e.holder.pid === A_PID`).
    const e = queryErr(b);
    expect(e).not.toBeNull();
    expect(e?.code).toBe('project_unavailable');
    expect(e?.reason).toBe('ownership_conflict');
    if (e !== null) {
      expect('holder' in e).toBe(true); // the field is present…
      expect(Object.is(e.holder, null)).toBe(true); // …as strict null (pre-fix: absent ⇒ undefined)
    }

    // Surface 2 — the direct `takeoverWorkspace` error `{ code:
    // "ownership_conflict" }`: the `holder` field is PRESENT and strict
    // null (pre-fix: absent ⇒ undefined).
    const to = b.takeoverWorkspace(PROJECT);
    expect(to.ok).toBe(false);
    if (!to.ok) {
      expect(to.error.code).toBe('ownership_conflict');
      const err = to.error as unknown as Record<string, unknown>;
      expect('holder' in err).toBe(true);
      expect(Object.is(err['holder'], null)).toBe(true);
    }

    // Nothing was written (record/claim untouched — the T1(a) invariant).
    chmodSync(recPath(root), 0o644);
    b.dispose();
    dropRoot(root);
  });
});