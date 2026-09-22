#!/usr/bin/env tsx
/**
 * fixtures/m4/reliability — INDEPENDENT checker (run under `npx tsx`).
 *
 * 1. re-derives the backup-manifest example from the committed v3 fixture
 *    (real bytes + digests);
 * 2. re-derives the transform cases (same-ID vs the 3-field new-ID rewrite);
 * 3. runs every §2 refusal case (R1–R8) through a REFERENCE IMPLEMENTATION
 *    of the §1–§2 procedures (backup/verify/restore/create) against temp
 *    trees — asserting the exact code AND that the originals are
 *    byte-identical after every refusal (the acceptance obligation);
 * 4. verifies the fault matrix (F1–F8 + the no-ready-partial invariant);
 * 5. verifies the health envelope (shape, bounds, redaction, cases);
 * 6. re-derives the frozen budget scenes (S1/S2 from committed bytes, S3 by
 *    replaying the packet-65 recipe through the real @thirdlight/commands
 *    engine — an independent second replay) and asserts every threshold row
 *    is marked BLOCKED (unmeasured, not invented);
 * 7. re-hashes index.json.
 *
 * Run: npx tsx fixtures/m4/reliability/tools/check-reliability.mts
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { applyMutation, createCommandState } from '@thirdlight/commands';

const FIXTURES_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = resolve(FIXTURES_DIR, '..', '..', '..');
const V3_DIR = join(REPO_ROOT, 'fixtures/m3/storage/project-v3-demo-0003');
const TMP = join(REPO_ROOT, 'fixtures/m4/reliability/.tmp-check');

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sha256File = (p: string) => sha256(readFileSync(p));
const blockDigest = (v: unknown) => sha256(Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8'));
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const readCase = <T,>(name: string): T => readJson<T>(join(FIXTURES_DIR, 'cases', name));
const writeJson = (p: string, v: unknown) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

let failures = 0;
const fail = (m: string) => { failures += 1; console.error(`FAIL: ${m}`); };
const ok = (m: string) => console.log(`ok: ${m}`);
const assertEq = (a: unknown, e: unknown, label: string) => {
  if (JSON.stringify(a) !== JSON.stringify(e)) fail(`${label}: expected ${JSON.stringify(e)?.slice(0, 200)}, got ${JSON.stringify(a)?.slice(0, 200)}`);
  else ok(label);
};

// ---- the reference implementation (reliability.md §1–§2) ----------------------
// A spec-level reference: the production tool ships with the packet-75/79
// tooling (CCR-67-1); this implementation exists to PROVE the fixture cases.

type Refusal = { ok: false; code: string; carries?: Record<string, unknown> };
const refusal = (code: string, carries?: Record<string, unknown>): Refusal => ({ ok: false, code, carries });
const live = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e: unknown) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** §1.2 precondition (released/stopped/dead-owner ⇒ proceed; live ⇒ refuse). */
function checkPrecondition(projectDir: string): { ok: true } | Refusal {
  const own = join(projectDir, '.thirdlight', 'ownership.json');
  if (!existsSync(own)) return { ok: true };
  const rec = readJson<any>(own);
  if (rec.state === 'released') return { ok: true };
  if (rec.state === 'owned' && live(rec.pid)) return refusal('backup_live_project', { holder: rec });
  return { ok: true }; // dead pid ⇒ stale ⇒ the accepted §6.2 rule
}

/** The consistent set (workspace.md §15) — the included files of a project. */
function consistentSet(projectDir: string): string[] {
  const files: string[] = ['project.json'];
  const scenesDir = join(projectDir, 'scenes');
  if (existsSync(scenesDir)) for (const f of readdirSync(scenesDir).sort()) files.push(`scenes/${f}`);
  const srcDir = join(projectDir, 'sources', 'sha256');
  if (existsSync(srcDir)) for (const f of readdirSync(srcDir).sort()) files.push(`sources/sha256/${f}`);
  return files;
}
const EXCLUDED = (p: string) =>
  p.includes('ownership.json') || /claim-/.test(p) || p.includes('staging/') || p.includes('derived/') ||
  p.includes('migration.json') || p.includes('.tmp');
const escapes = (p: string) => p.split('/').some((seg) => seg === '..') || p.startsWith('/') || p.startsWith('\\');

/** §1.5 backup — the consistent set into destDir, manifest written LAST. */
function backup(projectDir: string, projectId: string, destDir: string, dataRootLabel = 'thirdlight-data') {
  if (existsSync(destDir)) return refusal('backup_destination_exists');
  const pre = checkPrecondition(projectDir);
  if (!pre.ok) return pre;
  const rows: { path: string; byteLength: number; sha256: string }[] = [];
  mkdirSync(destDir, { recursive: true });
  for (const rel of consistentSet(projectDir)) {
    const src = join(projectDir, rel);
    if (!existsSync(src)) continue;
    const bytes = readFileSync(src);
    const dest = join(destDir, 'projects', projectId, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    rows.push({ path: `projects/${projectId}/${rel}`, byteLength: bytes.length, sha256: sha256(bytes) });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    v: 1, backupId: `bkp-${sha256(projectDir).slice(0, 32)}`, createdAt: '2026-09-22T00:00:00Z',
    engineVersion: '0.1.0', dataRootLabel, inventory: rows,
    inventoryDigest: `sha256:${blockDigest(rows.map((r) => ({ path: r.path, sha256: r.sha256 })))}`,
    projects: [{ projectId, blobCount: rows.filter((r) => r.path.includes('sources/')).length, catalogComplete: true }],
    retention: 'manual',
  };
  writeJson(join(destDir, 'backup-manifest.json'), manifest); // LAST
  return { ok: true, manifest };
}

/** §1.4 verify — ordered, read-only on the backup. */
function verify(backupDir: string): { ok: true; manifest: any } | Refusal {
  const manPath = join(backupDir, 'backup-manifest.json');
  if (!existsSync(manPath)) return refusal('backup_incomplete');
  let manifest: any;
  try { manifest = readJson<any>(manPath); } catch { return refusal('backup_manifest_invalid'); }
  if (manifest.v !== 1 || !Array.isArray(manifest.inventory)) return refusal('backup_manifest_invalid');
  for (const row of manifest.inventory) {
    if (escapes(row.path)) return refusal('backup_path_rejected', { path: row.path });
    if (EXCLUDED(row.path)) return refusal('backup_ownership_included', { path: row.path });
    const f = join(backupDir, row.path);
    if (!existsSync(f)) return refusal('backup_incomplete', { path: row.path }); // a listed file missing on disk = an interrupted copy
    const st = statSync(f);
    if (st.size < row.byteLength) return refusal('backup_truncated', { path: row.path, expected: row.byteLength, found: st.size });
    if (st.size !== row.byteLength || sha256File(f) !== row.sha256) return refusal('backup_hash_mismatch', { path: row.path });
  }
  if (manifest.inventoryDigest !== `sha256:${blockDigest(manifest.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`) {
    return refusal('backup_hash_mismatch', { path: 'backup-manifest.json' });
  }
  // step 4: the catalog ⊆ the inventory (every version, incl. superseded).
  const invPaths = new Set(manifest.inventory.map((r: any) => r.path));
  for (const p of manifest.projects ?? []) {
    const env = join(backupDir, 'projects', p.projectId, 'scenes', 'main.json');
    if (!existsSync(env)) continue;
    let envelope: any;
    try { envelope = readJson<any>(env); } catch { continue; } // unparseable envelope = a faithful backup of an invalid project (open surfaces the accepted code) — informational, not a refusal
    for (const asset of envelope.content?.assets ?? []) {
      for (const version of asset.versions ?? []) {
        const rel = `projects/${p.projectId}/sources/sha256/${version.sourceDigest}`;
        if (!invPaths.has(rel)) {
          const versions: any[] = asset.versions ?? [];
          const maxVersion = Math.max(...versions.map((v: any) => v.version));
          return refusal('backup_blob_missing', { assetId: asset.assetId, version: version.version, superseded: version.version < maxVersion });
        }
      }
    }
  }
  return { ok: true, manifest };
}

/** §2.1 restore — same-ID, verified, empty destination, identity checked first. */
function restore(backupDir: string, destProjectDir: string, projectId: string): { ok: true } | Refusal {
  const v = verify(backupDir);
  if (!v.ok) return v;
  const project = v.manifest.projects?.find((p: any) => p.projectId === projectId);
  if (!project) return refusal('restore_identity_mismatch', { projectId });
  if (existsSync(destProjectDir) && readdirSync(destProjectDir).length > 0) return refusal('restore_destination_nonempty');
  const manifestBytes = readFileSync(join(backupDir, 'projects', projectId, 'project.json'));
  const envelopeBytes = readFileSync(join(backupDir, 'projects', projectId, 'scenes', 'main.json'));
  const m = JSON.parse(manifestBytes.toString('utf8'));
  const e = JSON.parse(envelopeBytes.toString('utf8'));
  if (m.id !== projectId || e.projectId !== projectId || basename(destProjectDir) !== projectId) {
    return refusal('restore_identity_mismatch', { manifestId: m.id, envelopeProjectId: e.projectId });
  }
  // copy with the accepted atomic per-file discipline (temp + rename)
  for (const row of v.manifest.inventory) {
    if (!row.path.startsWith(`projects/${projectId}/`)) continue;
    const rel = row.path.slice(`projects/${projectId}/`.length);
    const dest = join(destProjectDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tl-tmp`;
    writeFileSync(tmp, readFileSync(join(backupDir, row.path)));
    renameSync(tmp, dest); // the atomic replacement
  }
  return { ok: true };
}

/** §2.2 create — the exact 3-field identity rewrite, nothing else. */
function createFromBackup(backupDir: string, destParent: string, newProjectId: string): { ok: true; rewritten: number } | Refusal {
  const v = verify(backupDir);
  if (!v.ok) return v;
  let rewritten = 0;
  for (const p of v.manifest.projects ?? []) {
    const destProjectDir = join(destParent, newProjectId);
    if (existsSync(destProjectDir) && readdirSync(destProjectDir).length > 0) return refusal('restore_destination_nonempty', { path: destProjectDir });
    const m = readJson<any>(join(backupDir, 'projects', p.projectId, 'project.json'));
    const e = readJson<any>(join(backupDir, 'projects', p.projectId, 'scenes', 'main.json'));
    if (m.id !== p.projectId || e.projectId !== p.projectId) return refusal('restore_identity_mismatch', { projectId: p.projectId });
    const nm = { ...m, id: newProjectId };
    const ne = { ...e, projectId: newProjectId };
    mkdirSync(join(destProjectDir, 'scenes'), { recursive: true });
    writeJson(join(destProjectDir, 'project.json'), nm);
    writeJson(join(destProjectDir, 'scenes', 'main.json'), ne);
    for (const row of v.manifest.inventory) {
      if (!row.path.startsWith(`projects/${p.projectId}/`)) continue;
      const rel = row.path.slice(`projects/${p.projectId}/`.length);
      if (rel === 'project.json' || rel === 'scenes/main.json') continue;
      const dest = join(destProjectDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(backupDir, row.path)));
    }
    rewritten += 1;
  }
  return { ok: true, rewritten };
}
function basename(p: string): string { return p.split('/').pop() ?? p; }

// ---- the refusal cases (R1–R8) -------------------------------------------------
function treeDigest(root: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(`${p.replace(root + '/', '')}:${sha256File(p)}`);
    }
  };
  walk(root);
  return sha256(files.sort().join('\n'));
}

async function runRefusalCases() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const cases = readCase<any>('refusal-cases.json');
  const copySource = (name: string) => {
    const d = join(TMP, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), readFileSync(join(V3_DIR, 'project.json')));
    mkdirSync(join(d, 'scenes'));
    writeFileSync(join(d, 'scenes/main.json'), readFileSync(join(V3_DIR, 'scenes/main.json')));
    return d;
  };
  const assertOriginals = (before: string, dir: string, label: string) => {
    if (treeDigest(dir) !== before) fail(`${label}: the original tree CHANGED (the refusal must retain the originals)`);
    else ok(`${label}: originals byte-identical after the refusal`);
  };

  // R1/R2: a valid backup, then truncated / hash-corrupted.
  {
    const src = copySource('r1-src');
    const before = treeDigest(src);
    const b1 = join(TMP, 'r1-backup');
    const r1 = backup(src, 'demo-0003', b1);
    if (!r1.ok) fail(`R0: the baseline backup failed: ${JSON.stringify(r1)}`);
    const b2 = join(TMP, 'r1-backup-t');
    if (backup(src, 'demo-0003', b2)!.ok !== true) fail('R1: baseline backup 2 failed');
    const env = join(b2, 'projects/demo-0003/scenes/main.json');
    writeFileSync(env, readFileSync(env).subarray(0, readFileSync(env).length - 100));
    const out = verify(b2);
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_truncated', 'R1: truncated backup refused');
    const b3 = join(TMP, 'r1-backup-h');
    if (backup(src, 'demo-0003', b3)!.ok !== true) fail('R2: baseline backup 3 failed');
    const man = join(b3, 'projects/demo-0003/project.json');
    const buf = Buffer.from(readFileSync(man));
    buf[20] ^= 0xff;
    writeFileSync(man, buf);
    const out2 = verify(b3);
    assertEq(out2.ok ? 'ok' : (out2 as Refusal).code, 'backup_hash_mismatch', 'R2: bad-hash backup refused');
    assertOriginals(before, src, 'R1/R2');
  }

  // R3: a temp project with one published blob; the backup omits it.
  {
    const src = copySource('r3-src');
    const blob = Buffer.from('reliability-r3-blob-bytes');
    const digest = sha256(blob);
    mkdirSync(join(src, 'sources/sha256'), { recursive: true });
    writeFileSync(join(src, 'sources/sha256', digest), blob);
    const env = readJson<any>(join(src, 'scenes/main.json'));
    env.content.assets.push({ assetId: 'asset-r3', kind: 'model', versions: [{ version: 1, sourceDigest: digest, sourceByteLength: blob.length }] });
    writeJson(join(src, 'scenes/main.json'), env);
    const before = treeDigest(src); // captured AFTER the setup mutation (the assertion is: the refusal itself changes nothing)
    const b = join(TMP, 'r3-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('R3: baseline backup failed');
    rmSync(join(b, `projects/demo-0003/sources/sha256/${digest}`));
    // the manifest row must go too (an omitted blob = the inventory lacks the path) — re-derive the manifest WITHOUT the row:
    const man = readJson<any>(join(b, 'backup-manifest.json'));
    man.inventory = man.inventory.filter((r: any) => !r.path.includes(digest));
    man.inventoryDigest = `sha256:${blockDigest(man.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`;
    writeJson(join(b, 'backup-manifest.json'), man);
    const out = verify(b);
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_blob_missing', 'R3: missing catalog blob refused');
    if (!out.ok) assertEq((out as Refusal).carries?.superseded, false, 'R3: carries superseded=false');
    assertOriginals(before, src, 'R3');
  }

  // R4: two versions of one asset; the backup omits the superseded v1.
  {
    const src = copySource('r4-src');
    const mk = (tag: string) => { const b = Buffer.from(`reliability-r4-${tag}`); return { bytes: b, digest: sha256(b) }; };
    const v1 = mk('v1');
    const v2 = mk('v2');
    mkdirSync(join(src, 'sources/sha256'), { recursive: true });
    writeFileSync(join(src, 'sources/sha256', v1.digest), v1.bytes);
    writeFileSync(join(src, 'sources/sha256', v2.digest), v2.bytes);
    const env = readJson<any>(join(src, 'scenes/main.json'));
    env.content.assets.push({ assetId: 'asset-r4', kind: 'model', versions: [
      { version: 1, sourceDigest: v1.digest, sourceByteLength: v1.bytes.length },
      { version: 2, sourceDigest: v2.digest, sourceByteLength: v2.bytes.length },
    ] });
    writeJson(join(src, 'scenes/main.json'), env);
    const before = treeDigest(src); // after setup (both blobs + the extended catalog)
    const b = join(TMP, 'r4-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('R4: baseline backup failed');
    rmSync(join(b, `projects/demo-0003/sources/sha256/${v1.digest}`));
    const man = readJson<any>(join(b, 'backup-manifest.json'));
    man.inventory = man.inventory.filter((r: any) => !r.path.includes(v1.digest));
    man.inventoryDigest = `sha256:${blockDigest(man.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`;
    writeJson(join(b, 'backup-manifest.json'), man);
    const out = verify(b);
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_blob_missing', 'R4: missing SUPERSEDED blob refused');
    if (!out.ok) assertEq((out as Refusal).carries?.superseded, true, 'R4: carries superseded=true');
    assertOriginals(before, src, 'R4');
  }

  // R5: an ownership.json in the inventory.
  {
    const src = copySource('r5-src');
    const before = treeDigest(src);
    const b = join(TMP, 'r5-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('R5: baseline backup failed');
    const man = readJson<any>(join(b, 'backup-manifest.json'));
    const ownBytes = readFileSync(join(REPO_ROOT, 'fixtures/m3/storage/project-v3-demo-0003/project.json')); // content irrelevant — the path is the trigger
    man.inventory.push({ path: 'projects/demo-0003/.thirdlight/ownership.json', byteLength: ownBytes.length, sha256: sha256(ownBytes) });
    man.inventoryDigest = `sha256:${blockDigest(man.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`;
    writeJson(join(b, 'backup-manifest.json'), man);
    const out = verify(b);
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_ownership_included', 'R5: ownership-included backup refused');
    assertOriginals(before, src, 'R5');
  }

  // R6: nonempty destination.
  {
    const src = copySource('r6-src');
    const b = join(TMP, 'r6-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('R6: baseline backup failed');
    const backupBefore = treeDigest(b);
    const destParent = join(TMP, 'r6-dest-parent');
    const dest = join(destParent, 'demo-0003');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'pre-existing.txt'), Buffer.from('existing bytes'));
    const destBefore = treeDigest(dest);
    const out = restore(b, dest, 'demo-0003');
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'restore_destination_nonempty', 'R6: nonempty destination refused (before the first write)');
    if (treeDigest(dest) !== destBefore) fail('R6: the existing destination CHANGED');
    else ok('R6: the existing destination byte-identical');
    if (treeDigest(b) !== backupBefore) fail('R6: the source backup CHANGED');
    else ok('R6: the source backup byte-identical');
  }

  // R7: an escaping inventory path.
  {
    const src = copySource('r7-src');
    const before = treeDigest(src);
    const b = join(TMP, 'r7-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('R7: baseline backup failed');
    const man = readJson<any>(join(b, 'backup-manifest.json'));
    man.inventory.push({ path: '../../etc/passwd', byteLength: 4, sha256: sha256('x') });
    man.inventoryDigest = `sha256:${blockDigest(man.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`;
    writeJson(join(b, 'backup-manifest.json'), man);
    const out = verify(b);
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_path_rejected', 'R7: path-escape inventory refused');
    assertOriginals(before, src, 'R7');
  }

  // R8: a live owner refuses; a dead owner proceeds.
  {
    const src = copySource('r8-src');
    const ownDir = join(src, '.thirdlight');
    mkdirSync(ownDir, { recursive: true });
    writeJson(join(ownDir, 'ownership.json'), { storageVersion: 1, state: 'owned', backendId: 'tb-0000000000000000000000000000dead', pid: process.pid, openedAt: '2026-09-22T00:00:00Z', lockEpoch: 0 });
    const before = treeDigest(src); // after setup (the ownership record is the precondition input)
    const out = backup(src, 'demo-0003', join(TMP, 'r8-backup-live'));
    assertEq(out.ok ? 'ok' : (out as Refusal).code, 'backup_live_project', 'R8: a LIVE owner refuses the backup (before any copy)');
    assertOriginals(before, src, 'R8-live');
    // dead-owner leg: spawn a short process, let it exit, use its pid.
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},40)'], { stdio: 'ignore' });
    await new Promise<void>((res) => child.on('exit', () => res()));
    const deadPid = child.pid ?? 999999999;
    if (live(deadPid)) fail(`R8: the spawned pid ${deadPid} is still alive (test setup bug)`);
    const src2 = copySource('r8-src-dead');
    const ownDir2 = join(src2, '.thirdlight');
    mkdirSync(ownDir2, { recursive: true });
    writeJson(join(ownDir2, 'ownership.json'), { storageVersion: 1, state: 'owned', backendId: 'tb-0000000000000000000000000000dead', pid: deadPid, openedAt: '2026-09-22T00:00:00Z', lockEpoch: 0 });
    const out2 = backup(src2, 'demo-0003', join(TMP, 'r8-backup-dead'));
    if (!out2.ok) fail(`R8: a DEAD owner should proceed (the accepted §6.2 stale rule), got ${JSON.stringify(out2)}`);
    else ok('R8: a dead owner proceeds (the stale rule — the accepted §6.2)');
  }

  // the positive legs (restore + create work on a clean destination)
  {
    const src = copySource('pos-src');
    const b = join(TMP, 'pos-backup');
    if (backup(src, 'demo-0003', b)!.ok !== true) fail('POS: baseline backup failed');
    const dest = join(TMP, 'pos-dest/demo-0003');
    mkdirSync(dirname(dest), { recursive: true });
    const out = restore(b, dest, 'demo-0003');
    if (!out.ok) fail(`POS-restore: ${JSON.stringify(out)}`);
    else {
      if (sha256File(join(dest, 'project.json')) !== sha256File(join(V3_DIR, 'project.json'))) fail('POS-restore: the restored manifest ≠ the source');
      else ok('POS: same-ID restore copies the consistent set byte-identically');
    }
    const out2 = createFromBackup(b, join(TMP, 'pos-create'), 'demo-0009');
    if (!out2.ok) fail(`POS-create: ${JSON.stringify(out2)}`);
    else {
      const m = readJson<any>(join(TMP, 'pos-create/demo-0009/project.json'));
      const e = readJson<any>(join(TMP, 'pos-create/demo-0009/scenes/main.json'));
      if (m.id !== 'demo-0009' || e.projectId !== 'demo-0009') fail('POS-create: the identity rewrite failed');
      else if (e.scene.revision !== readJson<any>(join(V3_DIR, 'scenes/main.json')).scene.revision) fail('POS-create: the revision changed (creation must NOT reset it)');
      else ok('POS: new-ID creation rewrites exactly the 3 identity fields (revision preserved)');
    }
  }
  rmSync(TMP, { recursive: true, force: true });
}

// ---- 1. backup example re-derivation -------------------------------------------
function checkBackupExample() {
  const fx = readCase<any>('backup-example.json');
  const manifestBytes = readFileSync(join(V3_DIR, 'project.json'));
  const envelopeBytes = readFileSync(join(V3_DIR, 'scenes/main.json'));
  const m = fx.manifest;
  assertEq(m.inventory[0].sha256, sha256(manifestBytes), 'backup example: manifest row digest = live fixture bytes');
  assertEq(m.inventory[1].sha256, sha256(envelopeBytes), 'backup example: envelope row digest = live fixture bytes');
  assertEq(m.inventoryDigest, `sha256:${blockDigest(m.inventory.map((r: any) => ({ path: r.path, sha256: r.sha256 })))}`, 'backup example: inventoryDigest re-derives');
  assertEq(m.projects[0].manifestDigest, `sha256:${sha256(manifestBytes)}`, 'backup example: manifestDigest re-derives');
  assertEq(m.projects[0].envelopeDigest, `sha256:${sha256(envelopeBytes)}`, 'backup example: envelopeDigest re-derives');
  assertEq(m.projects[0].revision, readJson<any>(join(V3_DIR, 'scenes/main.json')).scene.revision, 'backup example: revision = the live envelope revision');
  assertEq(m.retention, 'manual', 'backup example: retention is declared manual (no silent pruning)');
}

// ---- 2. transform cases re-derivation -------------------------------------------
function checkTransformCases() {
  const fx = readCase<any>('transform-cases.json');
  const manifestBytes = readFileSync(join(V3_DIR, 'project.json'));
  const envelopeBytes = readFileSync(join(V3_DIR, 'scenes/main.json'));
  const m = JSON.parse(manifestBytes.toString('utf8'));
  const e = JSON.parse(envelopeBytes.toString('utf8'));
  assertEq(fx.newId.before.manifestSha256, sha256(manifestBytes), 'transform: before manifest = live bytes');
  assertEq(fx.newId.before.envelopeSha256, sha256(envelopeBytes), 'transform: before envelope = live bytes');
  const nm = { ...m, id: fx.newId.newProjectId };
  const ne = { ...e, projectId: fx.newId.newProjectId };
  assertEq(fx.newId.after.manifestSha256, sha256(Buffer.from(`${JSON.stringify(nm, null, 2)}\n`)), 'transform: after manifest = ONLY the id field rewritten (byte-exact)');
  assertEq(fx.newId.after.envelopeSha256, sha256(Buffer.from(`${JSON.stringify(ne, null, 2)}\n`)), 'transform: after envelope = ONLY the projectId field rewritten (byte-exact)');
  assertEq(fx.newId.unchanged.revision, e.scene.revision, 'transform: the revision is preserved (creation is a copy, not a reset)');
  assertEq(fx.sameId.transform, 'none (verbatim copy)', 'transform: same-ID restore is a verbatim copy');
}

// ---- 3. fault matrix --------------------------------------------------------------
function checkFaultMatrix() {
  const fx = readCase<any>('fault-matrix.json');
  assertEq(fx.rows.map((r: any) => r.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'], 'fault matrix: the 8 rows in order');
  for (const r of fx.rows) {
    if (!r.fault || !r.state || !r.detection || !r.recovery || !r.originals) fail(`fault matrix: ${r.id} is incomplete`);
  }
  ok('fault matrix: every row carries state/detection/recovery/originals');
  if (!fx.invariant.includes('no-ready-partial')) fail('fault matrix: the C09 invariant is missing');
  else ok('fault matrix: the no-ready-partial (C09) invariant is pinned');
}

// ---- 4. health envelope -----------------------------------------------------------
function checkHealth() {
  const fx = readCase<any>('health-envelope.json');
  const ex = fx.example;
  const serialized = JSON.stringify(ex);
  if (serialized.length > 32 * 1024) fail('health: the example exceeds the 32 KiB bound');
  else ok('health: the example is within the 32 KiB bound');
  if (/\/home\/|\/etc\/|\/usr\//.test(serialized)) fail('health: an absolute path leaked into the example');
  else ok('health: no absolute paths in the example (redaction)');
  if (ex.workspace.blocked.length > 100 || ex.errors.length > 32) fail('health: a bounded list overflows the example');
  else ok('health: the bounded lists are within their bounds');
  assertEq(fx.limits.totalSerializedKiB, 32, 'health: the total bound is 32 KiB');
  if (fx.cases.length < 5) fail('health: the case set is incomplete');
  else ok(`health: the overflow/redaction/stale-identity cases (${fx.cases.length})`);
  const ids = fx.cases.map((c: any) => c.id);
  for (const id of ['H1-OVERFLOW', 'H2-ERROR-FLOOD', 'H3-SECRET-IMPOSSIBLE', 'H4-STALE-IDENTITY']) {
    if (!ids.includes(id)) fail(`health: case missing: ${id}`);
  }
  ok('health: the closed case ids are present');
}

// ---- 5. budget tables ----------------------------------------------------------------
function replayS3Independent() {
  const recipeDir = join(REPO_ROOT, 'fixtures/m4/templates/templates/platformer-starter');
  const recipeDoc = readJson<any>(join(recipeDir, 'recipe', 'commands.json'));
  const baseDoc = readJson<any>(join(recipeDir, 'base', 'scene.json'));
  const content = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
  let state: any = createCommandState(baseDoc as never, content as never);
  const origin = { kind: 'admin', clientId: `${recipeDoc.templateId}@1` };
  for (let i = 0; i < recipeDoc.commands.length; i += 1) {
    const cmd = recipeDoc.commands[i];
    const requestId = `req-${sha256(Buffer.from(`${recipeDoc.templateId}@1#${i + 1}`, 'utf8')).slice(0, 32)}`;
    const outcome = applyMutation(state, { op: cmd.op, projectId: 'starter-0001', expectedRevision: state.scene.revision, requestId, origin, args: cmd.args } as never);
    if (!outcome.ok) throw new Error(`S3 independent replay: command ${i + 1} failed: ${JSON.stringify((outcome as any).result)}`);
    state = (outcome as any).state;
  }
  const envelope = { storageVersion: 3, type: 'authoring-state', projectId: 'starter-0001', scene: state.scene, content: state.content, retry: { retention: 128, records: [] } };
  return { digest: sha256(Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')), revision: state.scene.revision, entityCount: state.scene.entities.length };
}

function checkBudget() {
  const fx = readCase<any>('budget-tables.json');
  assertEq(fx.namedDevice.status, 'BLOCKED — owner pending (reference-device.md §2)', 'budget: the device is BLOCKED (owner pending — not invented)');
  assertEq(fx.frozenScenes[0].identity.sha256, sha256File(join(V3_DIR, 'scenes/main.json')), 'budget: S1 digest = the committed v3 envelope bytes');
  assertEq(fx.frozenScenes[1].identity.sha256, sha256File(join(REPO_ROOT, 'samples/beacon-reach/captured/project.json')), 'budget: S2 digest = the committed captured project bytes');
  const s3 = replayS3Independent();
  assertEq(fx.frozenScenes[2].identity.sha256, s3.digest, 'budget: S3 digest = the independent engine replay (deterministic — generator and checker agree)');
  assertEq(fx.frozenScenes[2].derived, { revision: s3.revision, entityCount: s3.entityCount }, 'budget: S3 derived facts (revision/entityCount) match the replay');
  const blocked = fx.thresholdTable.rows.filter((r: any) => r.threshold.startsWith('BLOCKED — unmeasured'));
  if (blocked.length !== fx.thresholdTable.rows.length) fail(`budget: ${fx.thresholdTable.rows.length - blocked.length} threshold row(s) are NOT marked blocked (invented numbers are forbidden)`);
  else ok(`budget: every threshold row (${blocked.length}) is marked BLOCKED — unmeasured, not invented`);
  assertEq(fx.protocol.metricsClosed.length, 7, 'budget: the 7 closed metrics are pinned');
  if (!fx.protocol.noEarlyBoxData.includes('budget_source_not_refused')) {
    if (!fx.protocol.noEarlyBoxData.includes('budget_source_not_representative')) fail('budget: the no-early-box-data rule is missing its code');
    else ok('budget: the no-early-box-data rule pins its refusal code');
  }
}

// ---- 6. index -------------------------------------------------------------------------
function checkIndex() {
  const files = readdirSync(join(FIXTURES_DIR, 'cases')).sort().map((f) => `cases/${f}`);
  const index = readJson<any>(join(FIXTURES_DIR, 'index.json'));
  for (const f of files) {
    const bytes = readFileSync(join(FIXTURES_DIR, f));
    const row = index.files.find((r: any) => r.path === f);
    if (!row || row.byteLength !== bytes.length || row.sha256 !== sha256(bytes)) fail(`index row mismatch: ${f}`);
  }
  ok(`index.json rows verified (${files.length} files)`);
}

console.log('1. backup example');
checkBackupExample();
console.log('2. transform cases');
checkTransformCases();
console.log('3. refusal cases (the reference implementation)');
await runRefusalCases();
console.log('4. fault matrix');
checkFaultMatrix();
console.log('5. health envelope');
checkHealth();
console.log('6. budget tables (S3 via the real engine)');
checkBudget();
console.log('7. index');
checkIndex();

if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('reliability fixture checks: OK');