#!/usr/bin/env tsx
/**
 * fixtures/m4/reliability — packet 67 (reliability.md — 67-A backup /
 * diagnostics / recovery + 67-B budget protocol). Deterministic generator
 * (run under `npx tsx` — the S3 budget scene is re-derived by replaying the
 * packet-65 recipe through the real @thirdlight/commands engine).
 *
 * Generates:
 *   cases/backup-example.json    the backup-manifest example re-derived
 *                                from the committed v3 fixture (real bytes
 *                                + digests — the consistent set of
 *                                project-v3-demo-0003)
 *   cases/refusal-cases.json     the 8 refusal cases (setup, procedure,
 *                                expected code, original-preservation
 *                                assertion) — executed by the checker's
 *                                reference implementation
 *   cases/transform-cases.json   same-ID restore (no transform) vs new-ID
 *                                creation (the exact 3-field identity
 *                                rewrite, byte-exact on the v3 fixture)
 *   cases/fault-matrix.json      the F1–F8 normative fault matrix
 *                                (reliability.md §4)
 *   cases/health-envelope.json   the diagnostic report envelope (the
 *                                limits, redaction, overflow and
 *                                stale-identity cases)
 *   cases/budget-tables.json     the named device (BLOCKED placeholder),
 *                                the 3 frozen scene digests (S1/S2 from
 *                                committed bytes, S3 by engine replay),
 *                                the measurement protocol, the threshold
 *                                table (every row BLOCKED)
 *   index.json
 *
 * Run: npx tsx fixtures/m4/reliability/tools/generate-fixtures.mts [--check]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { applyMutation, createCommandState } from '@thirdlight/commands';

const FIXTURES_DIR = resolve(dirname(new URL(import.meta.url).pathname), '..');
// reliability/tools → reliability → m4 → fixtures → repo root (4 up).
const REPO_ROOT = resolve(FIXTURES_DIR, '..', '..', '..');
const CHECK = process.argv.includes('--check');

const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const blockDigest = (v: unknown) => createHash('sha256').update(Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8')).digest('hex');
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const V3_DIR = join(REPO_ROOT, 'fixtures/m3/storage/project-v3-demo-0003');

// ---- 1. the backup-manifest example (the committed v3 fixture) -------------
function backupExample() {
  const manifestBytes = readFileSync(join(V3_DIR, 'project.json'));
  const envelopeBytes = readFileSync(join(V3_DIR, 'scenes/main.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const envelope = JSON.parse(envelopeBytes.toString('utf8'));
  const inventory = [
    { path: 'projects/demo-0003/project.json', byteLength: manifestBytes.length, sha256: createHash('sha256').update(manifestBytes).digest('hex') },
    { path: 'projects/demo-0003/scenes/main.json', byteLength: envelopeBytes.length, sha256: createHash('sha256').update(envelopeBytes).digest('hex') },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const rows = inventory.map((e) => ({ path: e.path, sha256: e.sha256 }));
  return {
    note: 'The §1.3 backup-manifest shape instantiated on the committed v3 fixture (project-v3-demo-0003 — manifest + envelope, the empty asset catalog ⇒ 0 blobs; the consistent set of workspace.md §15). Every digest is re-derived from the live committed bytes by the checker.',
    manifest: {
      v: 1,
      backupId: 'bkp-00000000000000000000000000000000', // a record (operator CSPRNG in production), not an identity claim
      createdAt: '2026-09-22T00:00:00Z',
      engineVersion: '0.1.0',
      dataRootLabel: 'thirdlight-data',
      inventory,
      inventoryDigest: `sha256:${blockDigest(rows)}`,
      projects: [
        {
          projectId: manifest.id,
          manifestDigest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
          envelopeDigest: `sha256:${createHash('sha256').update(envelopeBytes).digest('hex')}`,
          revision: envelope.scene.revision,
          blobCount: 0,
          catalogComplete: true,
        },
      ],
      retention: 'manual',
    },
  };
}

// ---- 2. the refusal cases (executed by the checker's reference impl) -------
function refusalCases() {
  return {
    note: 'Each case: a temp source project (the committed v3 fixture bytes) + a temp backup/destination state, the procedure invoked, the expected code, and the original-preservation assertion (the source tree is byte-identical after the refusal — the acceptance obligation: "fixtures prove refusals retain originals"). The checker runs every case through its reference implementation of the §1–§2 procedures.',
    source: 'fixtures/m3/storage/project-v3-demo-0003 (project.json + scenes/main.json)',
    cases: [
      { id: 'R1-TRUNCATED', setup: 'a backup dir whose scenes/main.json is truncated (last 100 bytes removed)', procedure: 'verify', expected: 'backup_truncated', originals: 'the source project untouched (verify is read-only on the backup; the source is never read by verify)' },
      { id: 'R2-BAD-HASH', setup: 'a backup dir whose project.json has one flipped byte (the manifest byteLength unchanged)', procedure: 'verify', expected: 'backup_hash_mismatch', originals: 'the source project untouched' },
      { id: 'R3-BLOB-MISSING', setup: 'a backup dir whose inventory names a sources/sha256/<d> file that is absent, AND the envelope catalog names that digest (a temp catalog extension — the generator materializes a temp project with one published blob and the backup omits it)', procedure: 'verify', expected: 'backup_blob_missing (carries assetId, version, superseded: false)', originals: 'the source project (with its blob) untouched' },
      { id: 'R4-SUPERSEDED-BLOB-MISSING', setup: 'a temp project whose catalog carries versions 1 AND 2 of one asset (two digests); the backup omits the v1 file', procedure: 'verify', expected: 'backup_blob_missing (superseded: true — the §15 "every file, including superseded versions" rule)', originals: 'the source project (both blob files) untouched' },
      { id: 'R5-OWNERSHIP-INCLUDED', setup: 'a backup dir whose inventory includes a .thirdlight/ownership.json path', procedure: 'verify (step 5)', expected: 'backup_ownership_included', originals: 'the source project untouched' },
      { id: 'R6-NONEMPTY-DESTINATION', setup: 'a backup (verified) + a destination project dir that already exists with a byte in it', procedure: 'restore', expected: 'restore_destination_nonempty (checked BEFORE the first write)', originals: 'the existing destination byte-identical + the source backup untouched' },
      { id: 'R7-SYMLINK-ESCAPE', setup: 'a backup dir whose inventory path is ../../etc/passwd (an escape)', procedure: 'verify (step 6)', expected: 'backup_path_rejected', originals: 'the source project untouched' },
      { id: 'R8-LIVE-PROJECT', setup: 'the source project with a LIVE ownership record (owned, holder pid = a real live process — the checker records its own pid)', procedure: 'backup (the §1.2 precondition)', expected: 'backup_live_project (the copy never starts)', originals: 'the source project byte-identical (the refusal is before any read-copy); a second run with the record marked stale proceeds (the accepted §6.2 rule)' },
    ],
  };
}

// ---- 3. the transform cases --------------------------------------------------
function transformCases() {
  const manifestBytes = readFileSync(join(V3_DIR, 'project.json'));
  const envelopeBytes = readFileSync(join(V3_DIR, 'scenes/main.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const envelope = JSON.parse(envelopeBytes.toString('utf8'));
  const NEW_ID = 'demo-0009';
  const newManifest = { ...manifest, id: NEW_ID };
  const newEnvelope = { ...envelope, projectId: NEW_ID };
  return {
    note: 'Same-ID restore = NO transform (the bytes are copied verbatim into a same-name destination). New-ID creation = the EXACT 3-field identity rewrite (reliability.md §2.2) and nothing else — no revision reset (contrast the migration operators\' revisionPolicy reset-to-zero), history/retry preserved as authored, the template block preserved (provenance follows the content). The byte-exact old/new values below are re-derived by the checker from the live fixture bytes.',
    sameId: {
      transform: 'none (verbatim copy)',
      identity: { manifestId: manifest.id, envelopeProjectId: envelope.projectId, directory: manifest.id },
    },
    newId: {
      newProjectId: NEW_ID,
      transforms: [
        { field: 'manifest.id', before: manifest.id, after: NEW_ID },
        { field: 'envelope.projectId', before: envelope.projectId, after: NEW_ID },
        { field: 'directory name', before: manifest.id, after: NEW_ID },
      ],
      unchanged: {
        manifestBytesSha256ExceptId: 'the checker re-derives: the new manifest = JSON re-serialization of the parsed manifest with ONLY id changed',
        envelopeBytesSha256ExceptProjectId: 'the checker re-derives: the new envelope = the parsed envelope with ONLY projectId changed (scene.revision, content, retry byte-identical in structure)',
        revision: envelope.scene.revision,
        templateBlock: 'absent on this fixture (a v1 manifest — the rule holds vacuously; the 65 v2-manifest case is the C65-1 shape)',
      },
      before: {
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        envelopeSha256: createHash('sha256').update(envelopeBytes).digest('hex'),
      },
      after: {
        manifestSha256: createHash('sha256').update(Buffer.from(JSON.stringify(newManifest, null, 2) + '\n', 'utf8')).digest('hex'),
        envelopeSha256: createHash('sha256').update(Buffer.from(JSON.stringify(newEnvelope, null, 2) + '\n', 'utf8')).digest('hex'),
      },
    },
  };
}

// ---- 4. the fault matrix -----------------------------------------------------
function faultMatrix() {
  return {
    note: 'The §4 normative matrix — one row per crash/fault point. F1/F2/F6/F8 are the accepted machinery (workspace §5.1/§6.3/§7.5/§13.5); F3/F7 are the packet-65/66 surfaces; F4/F5 are the 67 operations. Every row: the on-disk state, the detection, the recovery, and the original-preservation outcome.',
    rows: [
      { id: 'F1', fault: 'crash mid-envelope write (any revision)', state: 'the pre-write envelope intact (the §5.1 atomic W: temp + rename + fsync — a torn write is impossible)', detection: 'open: the load pipeline succeeds at the previous revision (no error)', recovery: 'none', originals: 'intact (the envelope is either the old or the new whole document — §5.5)' },
      { id: 'F2', fault: 'crash between claim-file create and content write', state: 'orphan claim file at the target epoch', detection: 'open: claim_inconsistent (the §6.3 orphan)', recovery: 'operator file operation (prove the holder dead, remove the orphan claim file, re-issue the open — the accepted error hint; NO backend command)', originals: 'intact' },
      { id: 'F3', fault: 'crash in a template phase (packet 65 §5: reserved/blobs/envelope/replayed)', state: 'the reservation marker + the partial per-phase state', detection: 'open/scan: template_initialization_incomplete (the phase is recorded in the marker)', recovery: 'resume (the operator re-issues the same createProjectFromTemplate call — the dedup-safe deterministic requestIds) or delete the destination (operator file op)', originals: 'the template sources and every other project untouched (the destination is the only partial)' },
      { id: 'F4', fault: 'crash mid-backup (67)', state: 'a partial destDir without a valid backup-manifest.json (the manifest is written last)', detection: 'every 67 tool: backup_incomplete (the manifest is the gate)', recovery: 'delete-and-recreate (the tool refuses the nonempty destination — no merge, no partial adoption)', originals: 'the source project byte-identical (the backup is read-only on the source)' },
      { id: 'F5', fault: 'crash mid-restore/create (67)', state: 'a partial destination project directory', detection: 'the tool: restore_destination_nonempty on the re-run (the destination guard, checked before the first write)', recovery: 'delete the destination (operator file op), re-run from the verified backup', originals: 'the source backup and every existing project untouched' },
      { id: 'F6', fault: 'disk/write fault during any durable write', state: 'the W procedure surfaces the fault; the file is either the old or the new whole document', detection: 'the operation\'s failure code (content_publish_failed / the write-fault class); the envelope last-written hash check on next open', recovery: 'the accepted retry/takeover rules; no operator file op beyond the accepted claim rules', originals: 'intact (atomic replacement — no torn state)' },
      { id: 'F7', fault: 'a kit file tampered between vendor and use (66)', state: 'the vendored kit ≠ its kit.json identity', detection: 'the game-build tool\'s pre-build re-hash (before the pin comparison — a tampered kit is refused regardless of the pin)', recovery: 're-vendor the pinned kit (the operator re-assembles from the kit identity)', originals: 'the game project + game.json untouched (the refusal is before any build output)' },
      { id: 'F8', fault: 'a source blob corrupts (disk rot)', state: 'the catalog digest ≠ the file hash', detection: 'contentIntegrity (open/scan): blob_corrupt for the named version', recovery: 'the accepted §13.5 handling; a backup taken before the rot restores the bytes (the blob is the recoverable class)', originals: 'the envelope intact (the manifest + envelope are untouched by blob rot)' },
    ],
    invariant: 'no-ready-partial (C09): no fault point leaves a destination that opens as valid while actually partial — every partial state is detected with a named code before any valid-open claim.',
  };
}

// ---- 5. the health envelope ----------------------------------------------------
function healthEnvelope() {
  return {
    note: 'The §3 envelope + the limit/overflow/redaction/stale-identity cases. The shape is typed so an unredacted value cannot be represented; the serializer clips bounded lists (most recent kept) and sets truncated: true. The cases below are the pure-logic specification the 73/75 implementations and the serializer test must satisfy.',
    example: {
      v: 1, ts: '2026-09-22T12:00:00Z', backendId: 'tb-0123456789abcdef0123456789abcdef', engineVersion: '0.1.0',
      process: { pid: 4242, nodeVersion: '22.22.1', memoryKb: { rss: 8192, heapUsed: 4096 } },
      workspace: { projectsScanned: 3, projectsOk: 2, blocked: [{ projectId: 'demo-0002', reason: 'envelope_invalid' }] },
      sessions: { active: 1, logEntries: 37 },
      play: { activePlaySessions: 1, presented: 1 },
      content: { jobsActive: 0, uploadsActive: 0 },
      errors: [{ code: 'project_unavailable', cls: 'unavailable', at: '2026-09-22T11:59:58Z' }],
    },
    limits: { totalSerializedKiB: 32, blockedList: 100, errorsList: 32, overflow: 'the bounded list is clipped (most recent kept) and truncated: true is set — never an unbounded document, never a thrown serializer error' },
    redaction: ['no credentials/tokens (the §4.1 discipline)', 'no absolute paths (data-root-relative or digest/counter only)', 'no content bytes (digests/counters only)', 'no user names'],
    cases: [
      { id: 'H1-OVERFLOW', input: '101 blocked projects', result: 'blocked is clipped to the most recent 100; truncated: true; total ≤ 32 KiB' },
      { id: 'H2-ERROR-FLOOD', input: 'a 500-error flood since the last report', result: 'errors keeps the last 32 (the ring bound); the rest is dropped, not summarized into unbounded text' },
      { id: 'H3-SECRET-IMPOSSIBLE', input: 'a code path that would emit a token into a report field', result: 'unrepresentable by the envelope types; the serializer test rejects it (a defect, caught in CI — not a runtime condition)' },
      { id: 'H4-STALE-IDENTITY', input: 'a consumer cached the report across a backend restart (backendId changed)', result: 'the consumer MUST re-fetch (the normative stale-identity rule); a cached report is never asserted live; relayed diagnostics whose session/play no longer exist surface the accepted session_not_found / play_not_found' },
      { id: 'H5-HARDWARE-ABSENCE', input: 'a report on a machine without audio/display', result: 'the report asserts NOTHING about hardware (no capability fields) — the device record is the 67-B/79 surface; the absence is invisible to the report by design' },
    ],
  };
}

// ---- 6. the 67-B budget tables --------------------------------------------------
function replayS3() {
  const recipeDir = join(REPO_ROOT, 'fixtures/m4/templates/templates/platformer-starter');
  const recipeDoc = readJson<any>(join(recipeDir, 'recipe', 'commands.json'));
  const baseDoc = readJson<any>(join(recipeDir, 'base', 'scene.json'));
  const content = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
  let state: any = createCommandState(baseDoc as never, content as never);
  const origin = { kind: 'admin', clientId: `${recipeDoc.templateId}@1` };
  for (let i = 0; i < recipeDoc.commands.length; i += 1) {
    const cmd = recipeDoc.commands[i];
    const requestId = `req-${createHash('sha256').update(Buffer.from(`${recipeDoc.templateId}@1#${i + 1}`, 'utf8')).digest('hex').slice(0, 32)}`;
    const outcome = applyMutation(state, { op: cmd.op, projectId: 'starter-0001', expectedRevision: state.scene.revision, requestId, origin, args: cmd.args } as never);
    if (!outcome.ok) throw new Error(`S3 replay: command ${i + 1} (${cmd.op}) failed: ${JSON.stringify((outcome as any).result)}`);
    state = (outcome as any).state;
  }
  const envelope = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: 'starter-0001',
    scene: state.scene,
    content: state.content,
    retry: { retention: 128, records: [] },
  };
  return { digest: createHash('sha256').update(Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, 'utf8')).digest('hex'), revision: state.scene.revision, entityCount: state.scene.entities.length };
}

function budgetTables() {
  const s1 = sha256File(join(V3_DIR, 'scenes/main.json'));
  const s2 = sha256File(join(REPO_ROOT, 'samples/beacon-reach/captured/project.json'));
  const s3 = replayS3();
  return {
    note: '67-B: the protocol is frozen here; the numerical table is BLOCKED (reference-device.md §2/§3 — no representative hardware in this container; SwiftShader is never a hardware GPU claim; early box-only data is not representative calibration). Ratification checkpoint: docs/handoffs/67-budget-ratification.md — no scored 79 run until target review/promotion AND owner confirmation; 79 may run its candidate-assembly preflight first (after 76/78).',
    namedDevice: {
      status: 'BLOCKED — owner pending (reference-device.md §2)',
      proposedMinimum: 'x86-64 consumer desktop; real (non-SwiftShader) WebGL2 GPU with the GL_RENDERER string recorded; ≥ 1080p/60 Hz physical display; ≥ 4 cores / ≥ 8 GB (throttling disabled or recorded); physical keyboard + one gamepad; ≥ 1 audio output; backend on loopback; warm-cache conditions + observer tooling + clock resolution recorded per run',
    },
    frozenScenes: [
      { id: 'S1', name: 'the v3 demo envelope', identity: { file: 'fixtures/m3/storage/project-v3-demo-0003/scenes/main.json', sha256: s1 }, why: 'the committed baseline scene (2 zones, 2 spawns, no assets)' },
      { id: 'S2', name: 'the Beacon Reach captured project', identity: { file: 'samples/beacon-reach/captured/project.json', sha256: s2 }, why: 'the Gate P content scene (r26 — the full M3 content set)' },
      { id: 'S3', name: 'the template starter final scene', identity: { derivation: 'the 30-command packet-65 recipe replayed from the template base scene through the real @thirdlight/commands engine (deterministic requestIds; the admin origin substitution of templates.md §7.1); the canonical envelope serialization {storageVersion,type,projectId,scene,content,retry} (JSON, 2-space, trailing newline)', sha256: s3.digest }, derived: { revision: s3.revision, entityCount: s3.entityCount }, why: 'the M4 canonical game scene (20 entities, 7 assets, 1 prefab, 2 decoration instances, the animated courier)' },
    ],
    protocol: {
      environmentRecord: ['OS/kernel', 'CPU model + core count + throttling state', 'GPU + GL_RENDERER (software GL ⇒ the run is invalidated, not scored)', 'display resolution/refresh', 'Node version', 'the engine pin (the packet-66 kit identity)', 'the game pin (game.json)', 'the scene digest (must match a frozen row — else budget_scene_unfrozen)', 'browser + real (non-headless software-GL) viewport', 'cache state (warm-cache-only claims require the cache record)', 'clock source + resolution', 'observer tooling'],
      trials: '10-minute warmup; N ≥ 30 scored trials per metric (soak: the plan §2.6 duration); per-trial record { value, ts, trialIndex, environmentRecordHash }; statistics of record: median + p95 (p99 requires N ≥ 100 — below that it is marked insufficient_samples); no outlier discarding (recorded, not removed)',
      metricsClosed: ['play-present latency (POST → presented)', 'scene load time (iframe src → first frame presented)', 'frame-time p95/p99 (rAF delta, frameCount-tagged)', 'input-to-visible latency (key event → first rendered step with that input)', 'export duration (route → complete closure)', 'memory high-water (process RSS, per phase)', 'soak stability (30-min: dropped steps, error count, frame-time-ring GC observability)'],
      noEarlyBoxData: 'the container samples (baseline.md §6) are reproducibility samples only; a box-only number submitted as a threshold candidate is refused (budget_source_not_representative)',
    },
    thresholdTable: {
      status: 'BLOCKED — every threshold is unmeasured; filling the rows is the post-ratification 67-B resume (owner device + 76/78 complete + the 79 scored runs + the owner ratification)',
      rows: [
        { metric: 'play-present latency', scene: 'S3', condition: 'warm cache', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'scene load time', scene: 'S3', condition: 'warm cache', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'frame-time p95', scene: 'S3', condition: 'the 60 Hz display record', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'frame-time p99', scene: 'S3', condition: 'the 60 Hz display record', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'input-to-visible latency', scene: 'S3', condition: 'physical keyboard', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'export duration', scene: 'S3', condition: 'the kit-built game', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'memory high-water', scene: 'S3', condition: '30-min soak', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'soak stability', scene: 'S3', condition: '30-min run', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'the S1 baseline (no-assets floor)', scene: 'S1', condition: 'warm cache', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
        { metric: 'the S2 content floor', scene: 'S2', condition: 'warm cache', threshold: 'BLOCKED — unmeasured', sourceOfRecord: 'the 79 scored runs on the owner device' },
      ],
    },
  };
}

// ---- output ---------------------------------------------------------------------
function main() {
  const data: Record<string, unknown> = {
    'cases/backup-example.json': backupExample(),
    'cases/refusal-cases.json': refusalCases(),
    'cases/transform-cases.json': transformCases(),
    'cases/fault-matrix.json': faultMatrix(),
    'cases/health-envelope.json': healthEnvelope(),
    'cases/budget-tables.json': budgetTables(),
  };
  const files = Object.keys(data).sort();
  const buffers = new Map<string, Buffer>();
  for (const rel of files) {
    const bytes = Buffer.from(JSON.stringify(data[rel], null, 2) + '\n', 'utf8');
    buffers.set(rel, bytes);
    const abs = join(FIXTURES_DIR, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (CHECK) {
      if (!readFileSync(abs).equals(bytes)) throw new Error(`--check: ${rel} differs`);
      console.log(`  check OK: ${rel}`);
    } else {
      writeFileSync(abs, bytes);
      console.log(`wrote ${rel} (${bytes.length} bytes)`);
    }
  }
  const index = {
    note: 'byte length + sha256 of every generated data file (UTF-8 byte lengths). The S3 digest is re-derived by the generator AND the checker via the real command engine (deterministic replay).',
    files: files.map((rel) => ({ path: rel, byteLength: buffers.get(rel)!.length, sha256: createHash('sha256').update(buffers.get(rel)!).digest('hex') })),
  };
  const indexBytes = Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8');
  const indexAbs = join(FIXTURES_DIR, 'index.json');
  if (CHECK) {
    if (!readFileSync(indexAbs).equals(indexBytes)) throw new Error('--check: index.json differs');
    console.log('  check OK: index.json');
  } else {
    writeFileSync(indexAbs, indexBytes);
    console.log(`wrote index.json (${indexBytes.length} bytes)`);
  }
  console.log(CHECK ? 'fixture set verified byte-identical' : `generated ${files.length + 1} fixture files under ${FIXTURES_DIR}`);
}

main();