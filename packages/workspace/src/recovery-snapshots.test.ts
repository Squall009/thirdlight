/**
 * 2026-09-18 review repair — group D (R3 + R16) regression tests.
 *
 * Findings (docs/reviews/2026-09-18-commits.md, group D):
 *
 *   R3 (P1) — failed recovery snapshots are ignored; discard can destroy
 *            the only evidence: `detectExternalChange` ignored
 *            `snapshotForeignBytes` returning null and still recorded
 *            `snapshotState: "ok"`. Inject ENOSPC on the recovery
 *            temp-file open, leave foreign envelope bytes, and trigger a
 *            mutation: the result was ordinary `external_change_unresolved`
 *            (no failure evidence in the payload), and discard then
 *            succeeded — overwriting the foreign bytes with ZERO recovery
 *            snapshots. Violates workspace §5.5 G1.3 and §7.2–§7.4.
 *   R16 (P2) — same-second pruning can delete the snapshot just created:
 *            pruning sorted `UTCstamp-sha8` names without the §7.4
 *            exemption, so within one fixed second it kept snapshots by
 *            name order — with descending first-8-hex content hashes the
 *            17th (just-written, pending) snapshot was pruned immediately
 *            and discard succeeded with its foreign evidence gone.
 *
 * Repairs pinned here (workspace.md §7.2 step 2, §7.3, §7.4, §11; the
 * applied contract diff `dabfcff`):
 *   - the step-2 snapshot result is captured: `null` ⇒ the pending change
 *     records `snapshotState: "snapshot_failed"` (the §7.2 step-2
 *     normative state); the triggering mutation still fails
 *     `external_change_unresolved` — now carrying
 *     `pendingChange.snapshotState: "snapshot_failed"` — and the project
 *     pauses fail-closed (`paused-snapshot-failed`);
 *   - while `snapshotState === "snapshot_failed"`, accept AND discard are
 *     refused with `external_change_evidence_missing` (nothing written;
 *     the pending change and the pause persist; the refusal re-read does
 *     not silently re-snapshot);
 *   - the §7.3 re-establish path re-runs the §7.2 detection (which
 *     retries the snapshot through the same call): readable + durable
 *     snapshot ⇒ the resolution proceeds in the SAME call; snapshot still
 *     failing ⇒ refused `external_change_evidence_missing`;
 *   - §7.4 exemption: `pruneSnapshots(recoveryDir, ops, exemptHash)`
 *     identifies the exempt artifact as the file whose CONTENT SHA-256
 *     equals the pending `externalHash` (reading only the candidates
 *     whose name carries the 8-hex prefix) and keeps at most 16 in total,
 *     always including the exempt one — the just-written pending
 *     snapshot survives even when it is not the lexicographically newest
 *     name.
 *
 * Ported to storage v4 (phase 9.3 step B): the cases run on a v4
 * project's `scenes/scene-main.json`. The legacy §7.3 "re-read, re-run the
 * detection and proceed in the SAME call" once the snapshot can be taken
 * (old case 3, and the second half of old case 4) is not what v4 does:
 * acceptExternalV4/discardExternalV4 refuse any non-"ok" pending state with
 * external_change_evidence_missing without re-reading, so those assertions
 * are archived in archive/removed-v1-v2/workspace/recovery-snapshots.test.ts
 * (see the phase 9.3 report: a snapshot_failed pause cannot be resolved
 * without a restart). The §7.4 exemption cases (R16) hold for v4 as is.
 *
 * Real filesystem, unprivileged host user (case 4 uses a REAL
 * chmod-0500 `.thirdlight/recovery` directory — a real EACCES). Data
 * roots are disposable `mkdtemp` directories, cleaned in finally
 * (afterAll backstop). Fault injection goes through the sanctioned
 * `ops` seam (`WriteOps` — the snapshot temp-file open faults with
 * ENOSPC when the path is under `.thirdlight/recovery`) and the `stamp`
 * config seam (fixed value; deterministic snapshot names).
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService, type WriteOps } from '@thirdlight/workspace';

import { sha256Hex } from './digest';
import { defaultOps } from './write';

// ---- disposable roots (mkdtemp data roots; cleaned per test + backstop) ---

const roots: string[] = [];

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `tl07d-${tag}-`));
  roots.push(root);
  return root;
}

function dropRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort — the afterAll backstop retries
  }
}

afterAll(() => {
  for (const r of roots.splice(0)) dropRoot(r);
});

// ---- helpers -----------------------------------------------------------------

const BACKEND_ID = 'tb-11112222333344445555666677778888';
/** Pinned UTC stamp (config seam): snapshot names are deterministic. */
const PINNED_STAMP = '20260918T000000Z';
const STAMP_A = '20260918T000000Z';
const STAMP_B = '20260918T000001Z'; // later second (fixed-width ⇒ sorts after A)
const PROJECT = 'demo';
const SCENE_REL = join('projects', PROJECT, 'scenes', 'scene-main.json');

type Svc = ReturnType<typeof openWorkspaceService>;

let sequence = 0;

/** A `createEntity` mutation request at the given revision. */
function request(expectedRevision: number) {
  sequence += 1;
  return {
    op: 'createEntity',
    projectId: PROJECT,
    expectedRevision,
    requestId: `req-${sequence.toString(16).padStart(32, '0')}`,
    args: { kind: 'box', name: `Box ${sequence}` },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Open a service on a fresh root and create the project at revision 0. */
function openProject(root: string, opts: { stamp?: () => string; ops?: WriteOps } = {}): Svc {
  const s = openWorkspaceService({
    root,
    backendId: BACKEND_ID,
    stamp: opts.stamp ?? (() => PINNED_STAMP),
    ...(opts.ops === undefined ? {} : { ops: opts.ops }),
  });
  expect(s.createProject(PROJECT, 'Demo')).toEqual({
    ok: true,
    created: true,
    revision: 0,
  });
  return s;
}

const scenePath = (root: string): string => join(root, SCENE_REL);
const recoveryDir = (root: string): string =>
  join(root, 'projects', PROJECT, '.thirdlight', 'recovery');

/** Snapshot names in the project's recovery dir (empty when absent). */
function recoverySnaps(root: string): string[] {
  try {
    return readdirSync(recoveryDir(root)).filter((n) => n.startsWith('scene-')).sort();
  } catch {
    return [];
  }
}

const snapshotName = (h: string): string => `scene-${PINNED_STAMP}-${h.slice(0, 8)}.json`;

/** The query's workspace block (writePaused + pending change info). */
function queryWs(s: Svc): {
  writePaused: boolean;
  snapshotState: string | null;
  externalHash: string | null;
} {
  const q = s.query({ op: 'queryProject', projectId: PROJECT }) as {
    workspace:
      | { writePaused: false }
      | {
          writePaused: true;
          pendingChange: { snapshotState: string; externalHash: string | null };
        };
  };
  expect(q.workspace.writePaused).toBeDefined();
  if (q.workspace.writePaused === false) {
    return { writePaused: false, snapshotState: null, externalHash: null };
  }
  return {
    writePaused: true,
    snapshotState: q.workspace.pendingChange.snapshotState,
    externalHash: q.workspace.pendingChange.externalHash,
  };
}

/** The `external_change_unresolved` error payload of a failed mutation. */
function unresolvedError(m: unknown): Record<string, unknown> {
  const e = (m as { ok: false; error: Record<string, unknown> }).error;
  expect(e['code']).toBe('external_change_unresolved');
  expect(e['cls']).toBe('unavailable');
  return e['pendingChange'] as Record<string, unknown>;
}

/**
 * Foreign but VALID envelope bytes: the LKG envelope with one entity name
 * edited (same projectId, same scene shape — passes the full §4.3
 * pipeline ⇒ `externalValid: true`).
 */
function foreignValidEnvelope(lkg: Uint8Array): Uint8Array {
  const doc = JSON.parse(new TextDecoder().decode(lkg)) as {
    scene: { entities: { name: string }[] };
  };
  doc.scene.entities[0]!.name = 'Main Camera (foreign edit)';
  return new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
}

/**
 * `n` foreign byte strings whose first-8-hex SHA-256 values are strictly
 * DESCENDING (R16's repro shape: a fixed stamp makes name order = hash
 * order, so the just-written snapshot has the SMALLEST name). Each value
 * is rejection-sampled into its own fixed window
 * `[TOP - i*STEP, TOP - i*STEP + WIN)` — windows are disjoint (window =
 * half the step) and far from zero, so strict descent holds by
 * construction and every sample finds a value in a bounded number of
 * trials (~4k expected per window) — never chasing values down toward
 * `00000000` (which is unreachable and would loop forever).
 */
const SHA8_TOP = 0xffe00000;
const SHA8_STEP = 0x200000;
const SHA8_WIN = 0x100000;

function foreignInWindow(tag: string, slot: number): { bytes: Uint8Array; h8: string } {
  const enc = new TextEncoder();
  const lo = SHA8_TOP - slot * SHA8_STEP;
  const hi = lo + SHA8_WIN;
  let k = 0;
  let content: string;
  let v: number;
  do {
    content = `${tag}-${slot + 1}-p${k++}`;
    v = parseInt(sha256Hex(enc.encode(content)).slice(0, 8), 16);
  } while (v < lo || v >= hi);
  return { bytes: enc.encode(content), h8: v.toString(16).padStart(8, '0') };
}

function descendingForeigns(n: number, tag: string): { bytes: Uint8Array; h8: string }[] {
  const out: { bytes: Uint8Array; h8: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push(foreignInWindow(tag, i));
  }
  return out;
}

/**
 * The sanctioned fault surface: the ops seam faults the snapshot's
 * temp-file OPEN with an ENOSPC-class error when the path is under
 * `.thirdlight/recovery` (nothing else is touched — the scene writes of
 * create/mutate/resolve run on the real filesystem).
 */
function enospcRecoveryOps(flag: { on: boolean }): WriteOps {
  const marker = join('.thirdlight', 'recovery');
  return {
    ...defaultOps,
    openTempFile(p) {
      if (flag.on && p.includes(marker)) {
        throw { errno: 'ENOSPC' };
      }
      return defaultOps.openTempFile(p);
    },
  };
}

// ---- cases ---------------------------------------------------------------------

describe('2026-09-18 review group D (R3, R16) regressions', () => {
  it('1. R3 snapshot-creation failure (the review repro): ENOSPC on the recovery temp-file open ⇒ external_change_unresolved with snapshotState "snapshot_failed"; query paused with the same state; no snapshot artifact; foreign bytes byte-identical', () => {
    const root = makeRoot('r3a');
    try {
      const flag: { on: boolean } = { on: false };
      const s = openProject(root, { ops: enospcRecoveryOps(flag) });
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(root);
      const lkgBytes = readFileSync(scene);
      const foreign = foreignValidEnvelope(lkgBytes);
      const foreignHash = sha256Hex(foreign);

      writeFileSync(scene, foreign); // readable foreign bytes
      flag.on = true; // the snapshot's temp-file open now fails (ENOSPC)
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      const pc = unresolvedError(m);
      // §7.2 step 2 normative state: the bytes WERE read (the real hash is
      // carried) but no snapshot is durable.
      expect(pc['snapshotState']).toBe('snapshot_failed');
      expect(pc['externalHash']).toBe(foreignHash);
      expect(pc['externalValid']).toBe(true);

      // Query: paused with the snapshot_failed pending state.
      const ws = queryWs(s);
      expect(ws.writePaused).toBe(true);
      expect(ws.snapshotState).toBe('snapshot_failed');
      expect(ws.externalHash).toBe(foreignHash);

      // NO snapshot artifact was written (the recovery dir is empty).
      expect(recoverySnaps(root)).toEqual([]);
      // The foreign bytes are byte-identical (neither deleted nor "fixed").
      expect(bytesEqual(readFileSync(scene), foreign)).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it('2. R3 both resolutions refused while snapshot_failed (accept AND discard): nothing written, pending + pause persist, the refusal re-reads did not silently re-snapshot', () => {
    const root = makeRoot('r3b');
    try {
      const flag: { on: boolean } = { on: false };
      const s = openProject(root, { ops: enospcRecoveryOps(flag) });
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(root);
      const foreign = foreignValidEnvelope(readFileSync(scene));
      const foreignHash = sha256Hex(foreign);
      writeFileSync(scene, foreign);
      flag.on = true;
      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      unresolvedError(m); // external_change_unresolved (snapshot_failed)

      // ACCEPT refused (the re-read finds the same foreign bytes; the
      // snapshot retry fails while the seam still faults — nothing is
      // answered from a stale read, nothing is written).
      const a1 = s.acceptExternalState(PROJECT);
      expect(a1.ok).toBe(false);
      if (a1.ok) throw new Error('accept must be refused while snapshot_failed');
      const ea = a1.error as unknown as Record<string, unknown>;
      expect(ea['code']).toBe('external_change_evidence_missing');
      expect(ea['snapshotState']).toBe('snapshot_failed');
      expect((ea['pendingChange'] as Record<string, unknown>)['externalHash']).toBe(foreignHash);

      // DISCARD refused the same way.
      const d1 = s.discardExternalState(PROJECT);
      expect(d1.ok).toBe(false);
      if (d1.ok) throw new Error('discard must be refused while snapshot_failed');
      const ed = d1.error as unknown as Record<string, unknown>;
      expect(ed['code']).toBe('external_change_evidence_missing');
      expect(ed['snapshotState']).toBe('snapshot_failed');

      // Nothing was written: the target is byte-identical foreign bytes.
      expect(bytesEqual(readFileSync(scene), foreign)).toBe(true);
      // The refusal re-reads did NOT silently re-snapshot: the recovery
      // dir is still empty while the seam still faults.
      expect(recoverySnaps(root)).toEqual([]);
      // The pending change and the pause persist.
      const ws = queryWs(s);
      expect(ws.writePaused).toBe(true);
      expect(ws.snapshotState).toBe('snapshot_failed');
      expect(ws.externalHash).toBe(foreignHash);
    } finally {
      dropRoot(root);
    }
  });

  it('4. R3 with a REAL EACCES (chmod 0500 recovery dir): mutation fails with snapshot_failed, accept and discard refused, nothing written, no snapshot', () => {
    const root = makeRoot('r3d');
    try {
      const s = openProject(root);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(root);
      const lkgBytes = readFileSync(scene);
      const foreign = foreignValidEnvelope(lkgBytes);
      const foreignHash = sha256Hex(foreign);

      // REAL permission fault: the recovery dir exists (created by
      // createProject) and is made non-writable ⇒ the snapshot's temp-file
      // open fails with a real EACCES.
      const recDir = recoveryDir(root);
      chmodSync(recDir, 0o500);
      try {
        writeFileSync(scene, foreign);
        const m = s.runCommand(request(1));
        expect(m.ok).toBe(false);
        const pc = unresolvedError(m);
        expect(pc['snapshotState']).toBe('snapshot_failed');
        expect(pc['externalHash']).toBe(foreignHash);
        expect(pc['externalValid']).toBe(true);
        expect(recoverySnaps(root)).toEqual([]);

        // Accept refused while the evidence is missing (re-read readable;
        // the snapshot retry fails with the real EACCES).
        const a1 = s.acceptExternalState(PROJECT);
        expect(a1.ok).toBe(false);
        if (a1.ok) throw new Error('accept must be refused while snapshot_failed');
        expect((a1.error as unknown as Record<string, unknown>)['code']).toBe(
          'external_change_evidence_missing',
        );
        // Discard refused the same way (the LKG is not written back over
        // the unsnapshotted foreign bytes).
        const d1 = s.discardExternalState(PROJECT);
        expect(d1.ok).toBe(false);
        if (d1.ok) throw new Error('discard must be refused while snapshot_failed');
        expect((d1.error as unknown as Record<string, unknown>)['code']).toBe(
          'external_change_evidence_missing',
        );
        // Nothing was written.
        expect(bytesEqual(readFileSync(scene), foreign)).toBe(true);
        expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(false);
        expect(recoverySnaps(root)).toEqual([]);
        const ws = queryWs(s);
        expect(ws.writePaused).toBe(true);
        expect(ws.snapshotState).toBe('snapshot_failed');
        expect(ws.externalHash).toBe(foreignHash);
      } finally {
        chmodSync(recDir, 0o755); // restore before cleanup
      }
    } finally {
      try {
        chmodSync(recoveryDir(root), 0o755);
      } catch {
        // already restored (or gone)
      }
      dropRoot(root);
    }
  });

  it('5. R16 same-second exemption (the review repro): 17 fixed-stamp cycles with descending sha8 ⇒ after the 17th detection exactly 16 snapshots, the just-written (pending) one survives though it is not the lexicographically newest, and the pruned one is the oldest NON-EXEMPT by name order', () => {
    const root = makeRoot('r16a');
    try {
      const s = openProject(root);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(root);
      const lkgBytes = readFileSync(scene);
      const foreigns = descendingForeigns(17, 'r16-cycle');
      // Sanity: strictly descending first-8-hex values (the repro shape).
      for (let i = 1; i < foreigns.length; i++) {
        expect(foreigns[i]!.h8 < foreigns[i - 1]!.h8).toBe(true);
      }

      for (let i = 0; i < 17; i++) {
        const f = foreigns[i]!;
        writeFileSync(scene, f.bytes);
        const m = s.runCommand(request(1));
        expect(m.ok).toBe(false);
        const pc = unresolvedError(m);
        expect(pc['snapshotState']).toBe('ok'); // snapshot durable each cycle
        expect(pc['externalHash']).toBe(sha256Hex(f.bytes));
        if (i < 16) {
          // Resolve cycles 1–16 so each next foreign write is a fresh
          // detection (LKG restored, unpaused).
          const d = s.discardExternalState(PROJECT);
          expect(d).toEqual({ ok: true, revision: 1, historyReset: true });
        }
      }

      // After the 17th detection (BEFORE resolving it): exactly 16
      // snapshots; the just-written (pending, h17 — the SMALLEST name)
      // exists even though it is not the lexicographically newest; the
      // pruned one is h16 — the oldest NON-EXEMPT by name order.
      const snaps = recoverySnaps(root);
      expect(snaps.length).toBe(16);
      const expected = new Set(
        foreigns.slice(0, 15).map((f) => snapshotName(sha256Hex(f.bytes))),
      );
      const h17 = sha256Hex(foreigns[16]!.bytes);
      const h16 = sha256Hex(foreigns[15]!.bytes);
      expected.add(snapshotName(h17)); // the pending (exempt) snapshot
      expect(snaps).toEqual([...expected].sort());
      expect(snaps.includes(snapshotName(h17))).toBe(true);
      expect(snaps.includes(snapshotName(h16))).toBe(false);

      // Cycle 17 resolves normally (snapshot ok).
      const d17 = s.discardExternalState(PROJECT);
      expect(d17).toEqual({ ok: true, revision: 1, historyReset: true });
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(true);
    } finally {
      dropRoot(root);
    }
  });

  it('6. R16 exempt-while-pending across resolutions: after 17 resolved cycles (16 on disk), an 18th detection ⇒ exactly 16 on disk INCLUDING the new pending one (one older non-exempt pruned); the pending file is the just-written one', () => {
    const root = makeRoot('r16b');
    try {
      const s = openProject(root);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(root);
      const foreigns = descendingForeigns(17, 'r16-cycle2');

      for (let i = 0; i < 17; i++) {
        const f = foreigns[i]!;
        writeFileSync(scene, f.bytes);
        const m = s.runCommand(request(1));
        expect(m.ok).toBe(false);
        unresolvedError(m);
        const d = s.discardExternalState(PROJECT);
        expect(d).toEqual({ ok: true, revision: 1, historyReset: true });
      }
      expect(recoverySnaps(root).length).toBe(16);

      // The 18th detection with NEW foreign bytes: its sha8 is sampled in
      // the window BELOW the 17th's (slot 17) — distinct from the existing
      // snapshots, and (for the old-behavior repro) smaller in name order
      // than every existing snapshot.
      const f18 = foreignInWindow('r16-cycle2', 17);
      const h18 = f18.h8;
      writeFileSync(scene, f18.bytes);
      const m18 = s.runCommand(request(1));
      expect(m18.ok).toBe(false);
      const pc18 = unresolvedError(m18);
      expect(pc18['snapshotState']).toBe('ok');
      expect(pc18['externalHash']).toBe(sha256Hex(f18.bytes));

      // Exactly 16 on disk INCLUDING the new pending one: one older
      // non-exempt snapshot was pruned (h17 — the oldest non-exempt by
      // name order — since all 18 hashes are distinct and h17 < h1–h15).
      const snaps = recoverySnaps(root);
      expect(snaps.length).toBe(16);
      expect(snaps.includes(snapshotName(h18))).toBe(true);
      expect(snaps.includes(snapshotName(foreigns[16]!.h8))).toBe(false);
      // The pending file's name is the just-written one.
      expect(queryWs(s).externalHash).toBe(sha256Hex(f18.bytes));

      // Resolving the 18th cycle normally still works.
      const d18 = s.discardExternalState(PROJECT);
      expect(d18).toEqual({ ok: true, revision: 1, historyReset: true });
    } finally {
      dropRoot(root);
    }
  });

  it('7. Guards: (a) cross-stamp ordering — older-stamp snapshots pruned first, newest-stamp non-exempt survive within the 16 cap; (b) normal detection + discard with no fault still snapshots and resolves; (c) external_change_unresolved for a READABLE foreign change still carries snapshotState "ok" (the scenario-08 pinning)', () => {
    // (a) Two stamps (the stamp seam switches value mid-run); 10 cycles at
    // STAMP_A + 8 at STAMP_B = 18 detections ⇒ the 2 pruned are the
    // oldest STAMP_A snapshots; ALL 8 STAMP_B snapshots (7 non-exempt +
    // the 1 exempt pending) survive.
    const rootA = makeRoot('g7a');
    try {
      let stampVal = STAMP_A;
      const s = openProject(rootA, { stamp: () => stampVal });
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(rootA);
      const runCycles = (n: number, tag: string): string[] => {
        const hashes: string[] = [];
        const enc2 = new TextEncoder();
        for (let i = 0; i < n; i++) {
          let k = 0;
          let content: string;
          let h: string;
          do {
            content = `${tag}-${i + 1}-p${k}`;
            h = sha256Hex(enc2.encode(content)).slice(0, 8);
            k += 1;
          } while (hashes.includes(h));
          hashes.push(h);
          writeFileSync(scene, enc2.encode(content));
          const m = s.runCommand(request(1));
          expect(m.ok).toBe(false);
          unresolvedError(m);
          const d = s.discardExternalState(PROJECT);
          expect(d).toEqual({ ok: true, revision: 1, historyReset: true });
        }
        return hashes;
      };
      const ha = runCycles(10, 'g7a-A');
      stampVal = STAMP_B; // switch the seam to the later stamp
      runCycles(8, 'g7a-B');
      // After the last (resolved) 18th detection, the 16 retained are:
      // all 8 STAMP_B + the 8 newest STAMP_A (the 2 oldest STAMP_A were
      // pruned — older-stamp snapshots are pruned first).
      const snaps = recoverySnaps(rootA);
      expect(snaps.length).toBe(16);
      const bSnaps = snaps.filter((n) => n.startsWith(`scene-${STAMP_B}-`));
      const aSnaps = snaps.filter((n) => n.startsWith(`scene-${STAMP_A}-`));
      expect(bSnaps.length).toBe(8); // every newest-stamp snapshot survives
      expect(aSnaps.length).toBe(8);
      // The retained A names are the 8 LARGEST (newest) of the 10 written.
      const allA = ha.map((h) => `scene-${STAMP_A}-${h}.json`).sort();
      expect(aSnaps).toEqual(allA.slice(2));
    } finally {
      dropRoot(rootA);
    }

    // (b) + (c) Normal detection + discard with no fault: the readable
    // foreign change is the standard unresolved (the payload carries
    // snapshotState "ok" — the scenario-08 pinning), a real-byte snapshot
    // is taken, and the discard restores the LKG and unpauses.
    const rootB = makeRoot('g7b');
    try {
      const s = openProject(rootB);
      expect(s.runCommand(request(0)).ok).toBe(true); // LKG at revision 1
      const scene = scenePath(rootB);
      const lkgBytes = readFileSync(scene);
      const foreign = foreignValidEnvelope(lkgBytes);
      const foreignHash = sha256Hex(foreign);
      writeFileSync(scene, foreign);

      const m = s.runCommand(request(1));
      expect(m.ok).toBe(false);
      const pc = unresolvedError(m);
      expect(pc['snapshotState']).toBe('ok'); // (c) the scenario-08 pinning
      expect(pc['externalHash']).toBe(foreignHash);
      expect(pc['externalValid']).toBe(true);
      expect(queryWs(s).snapshotState).toBe('ok');
      const snaps = recoverySnaps(rootB);
      expect(snaps).toEqual([snapshotName(foreignHash)]);
      expect(bytesEqual(readFileSync(join(recoveryDir(rootB), snaps[0]!)), foreign)).toBe(true);

      const d = s.discardExternalState(PROJECT);
      expect(d).toEqual({ ok: true, revision: 1, historyReset: true });
      expect(bytesEqual(readFileSync(scene), lkgBytes)).toBe(true);
      expect(queryWs(s).writePaused).toBe(false);
      const m2 = s.runCommand(request(1));
      expect(m2.ok).toBe(true);
    } finally {
      dropRoot(rootB);
    }
  });
});