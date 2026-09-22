/**
 * Packet 37 — integrated M2 acceptance journey (non-browser half).
 *
 * Runs the REAL DEPLOYED artifacts at process level:
 *   - `dist/backend/backend.mjs`   (the built Node deployment bundle)
 *   - `dist/mcp-adapter/mcp.mjs`   (the built, self-contained stdio MCP server)
 *   - real filesystem, real HTTP on both origins, real WS, real stdio MCP SDK
 *   - a disposable data root and a disposable export root
 *
 * It executes the process/filesystem/HTTP/WS/SDK-executable parts of
 * docs/planning/m2-acceptance.md A01–A24 and the §3 integrated journey, and
 * writes a sanitized transcript + results JSON into ../journey/.
 *
 * Everything that requires a real browser/GPU/keyboard/gamepad is NOT run
 * here and is reported UNVERIFIED (see ../m2-report.md and the owner checklist).
 *
 * No credentials are real; the tokens are disposable test-only values and are
 * redacted from the transcript where they appear in artifacts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const EVIDENCE = resolve(HERE, '..');

const ADMIN_TOKEN = 'tl37-admin-token';
const AUTH_TOKEN = 'tl37-auth-token';
const M1_TOKEN = 'tl37-m1-token';
const AUTHORING_ORIGIN = 'http://127.0.0.1:8611';
const PREVIEW_ORIGIN = 'http://127.0.0.1:8612';
const AUTH_BIND = '127.0.0.1:8611';
const PREVIEW_BIND = '127.0.0.1:8612';

const M1_PROJECT = 'm1-live';
const M2_PROJECT = 'demo-m1-v2';
const MIGRATION_SOURCE = 'demo-m1';

const ROOT = mkdtempSync(join(tmpdir(), 'tl37-journey-'));
const DATA = join(ROOT, 'data');
const EXPORTS = join(ROOT, 'exports');
const BUNDLES = join(ROOT, 'bundles');
mkdirSync(join(DATA, 'projects'), { recursive: true });
mkdirSync(EXPORTS, { recursive: true });
mkdirSync(BUNDLES, { recursive: true });

const log = [];
const results = [];
let currentPhase = 'setup';

function say(line) {
  const s = String(line);
  log.push(s);
  console.log(s);
}
function phase(name) {
  currentPhase = name;
  say(`\n## ${name}`);
}
function record(id, status, detail) {
  results.push({ id, phase: currentPhase, status, detail: String(detail) });
  say(`[${status}] ${id} — ${detail}`);
}
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function fileHash(p) {
  return sha256Hex(new Uint8Array(readFileSync(p)));
}
function hashTree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel))) {
      const r = rel === '' ? entry : `${rel}/${entry}`;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = fileHash(join(dir, r));
    }
  };
  walk('');
  return out;
}
function redact(text) {
  return String(text).split(AUTH_TOKEN).join('<authoring-token>').split(ADMIN_TOKEN).join('<admin-token>');
}
function mkRequestId() {
  return `req-${randomBytes(16).toString('hex')}`;
}
function mkSessionId() {
  return `sess-${randomBytes(16).toString('hex')}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- HTTP -------------------------------------------------------------------

async function http(url, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  let body;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method: opts.method ?? (body === undefined ? 'GET' : 'POST'), headers, body });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const outHeaders = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  let parsed = null;
  if ((res.headers.get('content-type') ?? '').includes('json') && bytes.length > 0) {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  }
  return { status: res.status, body: parsed, headers: outHeaders, bytes };
}

// ---- deployed backend lifecycle --------------------------------------------

function backendEnv(exportRoot = EXPORTS) {
  return {
    ...process.env,
    THIRDLIGHT_DATA_ROOT: DATA,
    THIRDLIGHT_AUTHORING_ORIGIN: AUTHORING_ORIGIN,
    THIRDLIGHT_PREVIEW_ORIGIN: PREVIEW_ORIGIN,
    THIRDLIGHT_AUTHORING_BIND: AUTH_BIND,
    THIRDLIGHT_PREVIEW_BIND: PREVIEW_BIND,
    THIRDLIGHT_AUTHORING_ORIGINS: AUTHORING_ORIGIN,
    THIRDLIGHT_EDITOR_DIR: join(REPO, 'dist/editor'),
    THIRDLIGHT_PREVIEW_DIR: join(REPO, 'dist/preview'),
    THIRDLIGHT_TOKENS: `admin:${ADMIN_TOKEN},authoring:${M2_PROJECT}:${AUTH_TOKEN},authoring:${M1_PROJECT}:${M1_TOKEN}`,
    THIRDLIGHT_EXPORT_ROOT: exportRoot,
    THIRDLIGHT_ENGINE_ROOT: REPO,
  };
}

function startBackend(label, exportRoot = EXPORTS) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [join(REPO, 'dist/backend/backend.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: backendEnv(exportRoot),
    });
    let err = '';
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`backend ${label} did not become ready (stderr=${err})`));
    }, 30_000);
    proc.stderr.on('data', (d) => {
      err += new TextDecoder().decode(d);
      if (err.includes('listening')) {
        clearTimeout(timer);
        resolvePromise({ proc, origin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN, stderr: () => err, stdout: () => out });
      }
    });
    proc.stdout?.on('data', (d) => {
      out += new TextDecoder().decode(d);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (!err.includes('listening')) reject(new Error(`backend ${label} exited early code=${code} stderr=${err}`));
    });
  });
}

function stopBackend(bp, signal = 'SIGTERM') {
  return new Promise((resolvePromise) => {
    if (bp.proc.exitCode !== null) {
      resolvePromise();
      return;
    }
    bp.proc.once('exit', () => resolvePromise());
    bp.proc.kill(signal);
    setTimeout(() => {
      if (bp.proc.exitCode === null) bp.proc.kill('SIGKILL');
    }, 5000);
  });
}

// ---- WS owner stub (the editor's relay role) --------------------------------

class EditorStub {
  constructor(ws) {
    this.ws = ws;
    this.events = [];
    this.inputRequests = [];
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(new TextDecoder().decode(data));
      } catch {
        return;
      }
      this.events.push(msg);
      if (msg.type === 'play.started') {
        this.ws.send(JSON.stringify({ type: 'play.preview.ready', playSessionId: msg.playSessionId }));
      } else if (msg.type === 'play.stop.request') {
        this.ws.send(JSON.stringify({ type: 'play.stopped.ack', playSessionId: msg.playSessionId }));
      } else if (msg.type === 'input.request') {
        this.inputRequests.push(msg);
        const frames = msg.frames;
        this.ws.send(
          JSON.stringify({
            type: 'input.result',
            requestId: msg.requestId,
            ok: true,
            appliedFromStep: 100 + (frames[0]?.stepOffset ?? 0),
            appliedToStep: 100 + (frames[frames.length - 1]?.stepOffset ?? 0),
          }),
        );
      }
    });
  }
  static async open(origin, session) {
    const url = `${origin.replace('http', 'ws')}/api/v1/ws?sessionId=${session.sessionId}&wsToken=${session.wsToken}`;
    const ws = new WebSocket(url, { headers: { Origin: AUTHORING_ORIGIN } });
    await new Promise((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', (e) => rej(e instanceof Error ? e : new Error(String(e))));
    });
    return new EditorStub(ws);
  }
  close() {
    this.ws.close();
  }
}

async function establish(projectId, sessionId = mkSessionId(), token = AUTH_TOKEN) {
  const res = await tryEstablish(projectId, sessionId, token);
  if (!res.ok) throw new Error(`establish ${projectId} failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.session;
}

async function tryEstablish(projectId, sessionId = mkSessionId(), token = AUTH_TOKEN) {
  const res = await http(`${AUTHORING_ORIGIN}/api/v1/sessions`, {
    body: { projectId, sessionId, clientInfo: { kind: 'browser', label: 'packet-37-journey' } },
    token,
    origin: AUTHORING_ORIGIN,
  });
  if (res.status !== 200) return { ok: false, status: res.status, body: res.body };
  const b = res.body;
  return { ok: true, status: 200, body: b, session: { projectId, sessionId, connId: String(b.connId), wsToken: String(b.wsToken), revision: Number(b.revision), body: b } };
}

// ---- real stdio MCP over the DEPLOYED bundle --------------------------------

async function createMcp(projectId) {
  const env = { ...process.env };
  env.THIRDLIGHT_MCP_RUN = '1';
  env.THIRDLIGHT_AUTHORING_ORIGIN = AUTHORING_ORIGIN;
  env.THIRDLIGHT_PROJECT_ID = projectId;
  env.THIRDLIGHT_MCP_TOKEN = AUTH_TOKEN;
  env.THIRDLIGHT_MCP_CLIENT_ID = 'packet-37-mcp';
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(REPO, 'dist/mcp-adapter/mcp.mjs')],
    env,
    stderr: 'pipe',
  });
  const sdk = new Client({ name: 'packet-37-journey', version: '0.1.0' });
  await sdk.connect(transport);
  return {
    call: async (name, args) => {
      const res = await sdk.callTool({ name, arguments: args });
      const item = (res.content ?? []).find((c) => c.type === 'text' && typeof c.text === 'string');
      if (item === undefined) throw new Error('no text content');
      return { body: JSON.parse(item.text), isError: res.isError === true };
    },
    listTools: async () => (await sdk.listTools()).tools.map((t) => t.name),
    close: async () => sdk.close(),
  };
}

// ---- command helper ---------------------------------------------------------

function makeCommander(bp, projectId, origin = { kind: 'browser', clientId: 'packet-37' }, token = AUTH_TOKEN) {
  const state = { revision: 0 };
  const run = async (op, args = {}, opts = {}) => {
    const body = {
      op,
      projectId,
      expectedRevision: opts.expectedRevision ?? state.revision,
      requestId: opts.requestId ?? mkRequestId(),
      origin,
      args,
    };
    const res = await http(`${bp.origin}/api/v1/projects/${projectId}/commands`, {
      body,
      token,
      ...(origin.kind === 'browser' ? { origin: AUTHORING_ORIGIN } : {}),
    });
    if (res.status === 200 && res.body && res.body.ok === true) state.revision = Number(res.body.revision);
    return { status: res.status, body: res.body, requestId: body.requestId, expectedRevision: body.expectedRevision };
  };
  const query = async (op, args = {}) => {
    const res = await http(`${bp.origin}/api/v1/projects/${projectId}/commands`, {
      body: { op, projectId, args },
      token,
      ...(origin.kind === 'browser' ? { origin: AUTHORING_ORIGIN } : {}),
    });
    if (res.status === 200 && res.body && res.body.ok === true && typeof res.body.revision === 'number') state.revision = Number(res.body.revision);
    return { status: res.status, body: res.body };
  };
  const queryRevision = async () => {
    const res = await query('queryProject', {});
    if (res.status === 200 && res.body?.ok) return Number(res.body.revision);
    throw new Error(`queryProject failed ${res.status} ${JSON.stringify(res.body)}`);
  };
  return { run, query, queryRevision, state };
}

// ---- content helpers (real stage/upload/inspect over HTTP) ------------------

async function stageAndInspect(bp, projectId, bytes) {
  const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN };
  const created = await http(`${bp.origin}/api/v1/projects/${projectId}/content/stages`, { ...auth, body: {} });
  if (created.status !== 200) return { ok: false, stage: 'create', body: created.body, status: created.status };
  const stageId = created.body.stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(bytes.length),
    },
    body: bytes,
  });
  if (put.status !== 200) return { ok: false, stage: 'upload', status: put.status };
  const inspected = await http(`${bp.origin}/api/v1/projects/${projectId}/content/stages/${stageId}/inspect`, { ...auth, body: {} });
  if (inspected.status !== 200) return { ok: false, stage: 'inspect', status: inspected.status, body: inspected.body, stageId };
  return { ok: true, stageId, proposal: inspected.body.proposal, status: 200 };
}

async function stageAndUpload(bp, projectId, bytes) {
  const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN };
  const created = await http(`${bp.origin}/api/v1/projects/${projectId}/content/stages`, { ...auth, body: {} });
  if (created.status !== 200) return { ok: false, stage: 'create', status: created.status, body: created.body };
  const stageId = created.body.stageId;
  const put = await fetch(`${bp.origin}/api/v1/projects/${projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      origin: AUTHORING_ORIGIN,
      'content-type': 'application/octet-stream',
      'x-thirdlight-offset': '0',
      'x-thirdlight-total': String(bytes.length),
    },
    body: bytes,
  });
  if (put.status !== 200) return { ok: false, stage: 'upload', status: put.status };
  return { ok: true, stageId, status: 200 };
}

function fixtureBytes(rel) {
  return new Uint8Array(readFileSync(join(REPO, 'fixtures/m2', rel)));
}

function publishAssetArgs(mode, assetId, proposal, displayName) {
  return {
    mode,
    assetId,
    displayName,
    sourceDigest: String(proposal.sourceDigest),
    sourceByteLength: Number(proposal.sourceByteLength),
    importRecipe: proposal.importRecipe,
    metrics: proposal.metrics,
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function publishBehaviorSource(bp, projectId, cmd, behaviorId, declaration, container) {
  const auth = { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN };
  const sourceDigest = sha256Hex(container);
  const staged = await stageAndUpload(bp, projectId, container);
  if (!staged.ok) throw new Error(`behavior stage failed: ${JSON.stringify(staged)}`);
  await cmd.run('publishBehavior', { behaviorId, displayName: 'Packet 37 behavior', mode: 'declaration-create', declaration });
  await cmd.run('acknowledgeBehaviorTrust', { sourceDigest });
  const res = await http(`${bp.origin}/api/v1/projects/${projectId}/content/behaviors/source`, {
    ...auth,
    body: { stageId: staged.stageId, behaviorId, displayName: 'Packet 37 behavior', declaration, expectedRevision: cmd.state.revision, requestId: mkRequestId() },
  });
  if (res.status !== 200) throw new Error(`behavior source publish failed: ${res.status} ${JSON.stringify(res.body)}`);
  cmd.state.revision = Number(res.body.revision);
  return { sourceDigest: String(res.body.sourceDigest), outputDigest: String(res.body.outputDigest) };
}

// ---- migration copy (real subprocess over the real workspace) ---------------

async function runMigration(dataRoot, sourceProjectId, newProjectId) {
  const entry = `
import { openWorkspaceService } from ${JSON.stringify(join(REPO, 'packages/workspace/src/index.ts'))};
const svc = openWorkspaceService({ root: process.env.TL37_DATA_ROOT, utcNow: () => '2026-09-18T12:00:00Z' });
const res = svc.migrateProjectCopy(process.env.TL37_SRC, process.env.TL37_DST);
process.stdout.write(JSON.stringify(res));
`;
  const out = join(BUNDLES, 'migrate.mjs');
  await build({
    stdin: { contents: entry, resolveDir: REPO, sourcefile: 'migrate.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    external: ['esbuild'],
    logLevel: 'silent',
  });
  const child = spawn(process.execPath, [out], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TL37_DATA_ROOT: dataRoot, TL37_SRC: sourceProjectId, TL37_DST: newProjectId },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += new TextDecoder().decode(d)));
  child.stderr.on('data', (d) => (stderr += new TextDecoder().decode(d)));
  const code = await new Promise((r) => child.on('exit', r));
  if (code !== 0) throw new Error(`migration subprocess exited ${code}: ${stderr.slice(0, 400)}`);
  return JSON.parse(stdout);
}

// ---- static server (independent, non-root subpath) --------------------------

async function startStaticServer(rootDir, basePath) {
  const { createServer } = await import('node:http');
  const { extname, normalize } = await import('node:path');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
    '.wasm': 'application/wasm',
  };
  const mimeFor = (rel) => {
    if (/^content\/sha256\/[0-9a-f]{64}$/.test(rel)) return 'model/gltf-binary';
    if (/^behaviors\/[0-9a-f]{64}\.js$/.test(rel)) return 'text/javascript; charset=utf-8';
    return MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream';
  };
  const requests = [];
  let external = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith(basePath)) {
      external += 1;
      res.writeHead(404).end('not found');
      return;
    }
    requests.push(url);
    const rel = decodeURIComponent(url.slice(basePath.length).split('?')[0] ?? '');
    const target = resolve(rootDir, normalize(rel));
    if (!target.startsWith(resolve(rootDir)) || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = readFileSync(target);
    res.writeHead(200, {
      'content-type': mimeFor(rel),
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    basePath,
    requests,
    get externalRequests() {
      return external;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ---- artifacts written into the evidence dir --------------------------------

function writeEvidence(name, data) {
  const p = join(EVIDENCE, 'journey', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, redact(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
  return p;
}

// ============================================================================
// phases
// ============================================================================

async function main() {
  say(`# Packet 37 integrated journey (deployed artifacts)\n`);
  say(`- repo: ${REPO}`);
  say(`- disposable root: ${ROOT}`);
  say(`- backend bundle sha256: ${fileHash(join(REPO, 'dist/backend/backend.mjs'))}`);
  say(`- mcp bundle sha256: ${fileHash(join(REPO, 'dist/mcp-adapter/mcp.mjs'))}`);

  // ---------------- A01: seed M1 fixture + operator migration-copy ----------
  phase('A01 migration-copy (A09 durability)');
  cpSync(join(REPO, 'fixtures/m2/contracts/migration/v1-source'), join(DATA, 'projects', MIGRATION_SOURCE), { recursive: true });
  const srcBefore = hashTree(join(DATA, 'projects', MIGRATION_SOURCE));
  const migration = await runMigration(DATA, MIGRATION_SOURCE, M2_PROJECT);
  const srcAfter = hashTree(join(DATA, 'projects', MIGRATION_SOURCE));
  const destTree = hashTree(join(DATA, 'projects', M2_PROJECT));
  const expected = hashTree(join(REPO, 'fixtures/m2/contracts/migration/expected-v2-destination'));
  const sourceIdentical = JSON.stringify(srcBefore) === JSON.stringify(srcAfter);
  const destEqualsExpected =
    fileHash(join(DATA, 'projects', M2_PROJECT, 'project.json')) === fileHash(join(REPO, 'fixtures/m2/contracts/migration/expected-v2-destination/project.json')) &&
    fileHash(join(DATA, 'projects', M2_PROJECT, 'scenes/main.json')) === fileHash(join(REPO, 'fixtures/m2/contracts/migration/expected-v2-destination/scenes/main.json'));
  record('A01.migration', migration.ok && sourceIdentical && destEqualsExpected ? 'PASS' : 'FAIL', `ok=${migration.ok} resumed=${migration.resumed} sourceRevision=${migration.sourceRevision} newRevision=${migration.newRevision} policy=${migration.revisionPolicy} sourceBytesIdentical=${sourceIdentical} destEqualsAcceptedFixture=${destEqualsExpected}`);
  writeEvidence('01-migration.json', { migration, sourceIdentical, destEqualsExpected, destTree, expectedTree: expected });

  // ---------------- backend start -------------------------------------------
  let bp = await startBackend('boot-1');
  say(`backend ready (pid ${bp.proc.pid})`);

  // ---------------- A01: M1 v1 opens/edits unchanged + malformed version ----
  {
    const created = await http(`${AUTHORING_ORIGIN}/api/v1/admin/projects`, { token: ADMIN_TOKEN, origin: AUTHORING_ORIGIN, body: { projectId: M1_PROJECT, name: 'M1 Live' } });
    const envPath = join(DATA, 'projects', M1_PROJECT, 'scenes/main.json');
    const envBefore = fileHash(envPath);
    // the admin token covers every project scope (M1 project has no authoring token here)
    const cmd = makeCommander(bp, M1_PROJECT, { kind: 'browser', clientId: 'packet-37-m1' }, M1_TOKEN);
    const m1Session = await establish(M1_PROJECT, mkSessionId(), M1_TOKEN);
    void m1Session;
    const q = await cmd.query('queryProject', {});
    cmd.state.revision = Number(q.body.revision);
    const box = await cmd.run('createEntity', { kind: 'box', name: 'M1 Box', parentId: null, transform: { position: [0, 0, 0] } });
    const boxOk = box.status === 200 && box.body.ok === true && String(box.body.createdId).startsWith('box-');
    // unknown/malformed versions must fail without rewrite: seed a v1 project
    // on disk with an unknown storageVersion and open it (never previously loaded)
    const BAD = 'bad-version';
    const badDir = join(DATA, 'projects', BAD);
    cpSync(join(REPO, 'fixtures/m2/contracts/migration/v1-source'), badDir, { recursive: true });
    const badProject = JSON.parse(readFileSync(join(badDir, 'project.json'), 'utf8'));
    badProject.id = BAD;
    writeFileSync(join(badDir, 'project.json'), `${JSON.stringify(badProject, null, 2)}\n`);
    const badEnvPath = join(badDir, 'scenes/main.json');
    const badEnv = JSON.parse(readFileSync(badEnvPath, 'utf8'));
    badEnv.projectId = BAD;
    badEnv.storageVersion = 99;
    writeFileSync(badEnvPath, `${JSON.stringify(badEnv, null, 2)}\n`);
    const badHash = fileHash(badEnvPath);
    const bad = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${BAD}/commands`, {
      token: ADMIN_TOKEN,
      origin: AUTHORING_ORIGIN,
      body: { op: 'queryProject', projectId: BAD, args: {} },
    });
    const badHashAfter = fileHash(badEnvPath);
    record('A01.m1-v1', created.status === 201 && boxOk && bad.status !== 200 && badHash === badHashAfter ? 'PASS' : 'FAIL',
      `create=${created.status} v1CommandOk=${boxOk} boxError=${box.body?.error?.code ?? ''} malformedStatus=${bad.status} malformedCode=${bad.body?.error?.code} fileUnchanged=${badHash === badHashAfter}`);
    writeEvidence('02-m1-v1.json', { created: created.status, boxOk, boxResponse: box.body, malformedStatus: bad.status, malformedError: bad.body?.error ?? null, envBefore, badHash, badHashAfter });
  }

  // ---------------- M2 authoring journey ------------------------------------
  const session = await establish(M2_PROJECT);
  const editor = await EditorStub.open(bp.origin, session);
  const cmd = makeCommander(bp, M2_PROJECT);
  await cmd.queryRevision();

  // A02/A03: import GLB v1, place two instances, reimport v2, undo/redo
  phase('A02/A03/A04 content import, reimport, malformed rejection');
  let assetId = 'asset-00000000000037a1';
  let glbV1Digest = '';
  let malformedUnchanged = false;
  const placements = [];
  {
    const v1 = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/tiny-v1.glb'));
    glbV1Digest = String(v1.proposal.sourceDigest);
    const pub = await cmd.run('publishAsset', publishAssetArgs('create', assetId, v1.proposal, 'Tiny v1'));
    const place1 = await cmd.run('createEntity', { kind: 'model', name: 'Tiny A', parentId: null, model: { asset: { assetId } } });
    const place2 = await cmd.run('createEntity', { kind: 'model', name: 'Tiny B', parentId: null, model: { asset: { assetId } } });
    const id1 = String(place1.body.createdId);
    const id2 = String(place2.body.createdId);
    placements.push(id1, id2);
    const before2 = await cmd.query('queryEntities', { limit: 256, offset: 0 });
    const ent1 = before2.body.entities.find((e) => e.id === id1);
    const ent2 = before2.body.entities.find((e) => e.id === id2);
    record('A02.import+place', pub.status === 200 && place1.status === 200 && place2.status === 200 && id1 !== id2 ? 'PASS' : 'FAIL',
      `assetId=${assetId} v1Digest=${glbV1Digest.slice(0, 16)}… placements=${id1},${id2} distinct=${id1 !== id2}`);

    // malformed replacement (A04): previous catalog/scene/revision unchanged
    const envPath = join(DATA, 'projects', M2_PROJECT, 'scenes/main.json');
    const envBefore = fileHash(envPath);
    const revBefore = cmd.state.revision;
    const bad = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/bad-chunk.glb'));
    const external = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/external-uri-buffer.glb'));
    const req = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/required-extension.glb'));
    const limit = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/decoded-limit.glb'));
    const envAfter = fileHash(envPath);
    const revAfter = await cmd.queryRevision();
    malformedUnchanged = envBefore === envAfter && revBefore === revAfter && !bad.ok && !external.ok && !req.ok && !limit.ok;
    record('A04.reject', malformedUnchanged ? 'PASS' : 'FAIL',
      `bad=${!bad.ok} external=${!external.ok} required-ext=${!req.ok} limit=${!limit.ok} envelopeUnchanged=${envBefore === envAfter} revisionUnchanged=${revBefore === revAfter}`);

    // A03 reimport v2 under the same assetId; IDs/transform stable; undo/redo
    const v2 = await stageAndInspect(bp, M2_PROJECT, fixtureBytes('assets/tiny-v2.glb'));
    const re = await cmd.run('publishAsset', publishAssetArgs('reimport', assetId, v2.proposal, 'Tiny v2'));
    const after = await cmd.query('queryEntities', { limit: 256, offset: 0 });
    const ent1b = after.body.entities.find((e) => e.id === id1);
    const ent2b = after.body.entities.find((e) => e.id === id2);
    const stable = JSON.stringify(ent1b.components.transform) === JSON.stringify(ent1.components.transform) &&
      JSON.stringify(ent2b.components.transform) === JSON.stringify(ent2.components.transform) &&
      ent1b.components.model.asset.assetId === assetId && ent2b.components.model.asset.assetId === assetId;
    const catalogAfter = await cmd.query('queryAssets', { limit: 128, offset: 0, includeVersions: true });
    const rec = catalogAfter.body.assets.find((a) => a.assetId === assetId);
    const verAfter = rec.currentVersion;
    await cmd.run('undo', {});
    const catalogUndo = await cmd.query('queryAssets', { limit: 128, offset: 0, includeVersions: true });
    const verUndo = catalogUndo.body.assets.find((a) => a.assetId === assetId).currentVersion;
    await cmd.run('redo', {});
    const catalogRedo = await cmd.query('queryAssets', { limit: 128, offset: 0, includeVersions: true });
    const verRedo = catalogRedo.body.assets.find((a) => a.assetId === assetId).currentVersion;
    record('A03.reimport', re.status === 200 && stable && verAfter === 2 && verUndo === 1 && verRedo === 2 ? 'PASS' : 'FAIL',
      `reimport=${re.status} idsTransformsStable=${stable} version v2=${verAfter} undo=${verUndo} redo=${verRedo}`);
    writeEvidence('03-import-reimport.json', { assetId, glbV1Digest, v1: v1.proposal, v2: v2.proposal, stable, verAfter, verUndo, verRedo, malformedUnchanged });
  }

  // A05/A06 prefabs + declared properties
  phase('A05/A06/A07 prefab, declared properties, MCP parity');
  let prefabId = 'prefab-0001';
  {
    const decl = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }, { key: 'target', label: 'Target', type: 'entityRef', default: null }] };
    await cmd.run('publishBehavior', { behaviorId: 'behavior-0001', displayName: 'Lantern Glow', mode: 'declaration-create', declaration: decl });
    const group = await cmd.run('createEntity', { kind: 'group', name: 'Kit', parentId: null });
    const groupId = String(group.body.createdId);
    const box = await cmd.run('createEntity', { kind: 'box', name: 'Kit Box', parentId: groupId });
    const boxId = String(box.body.createdId);
    await cmd.run('setBehaviorProperties', { entityId: boxId, behaviorId: 'behavior-0001', values: { speed: 4.5, target: groupId } });
    const capture = await cmd.run('createPrefab', { prefabId, displayName: 'Kit', sourceEntityId: groupId });
    const inst = await cmd.run('instantiatePrefab', { prefabId, overrides: [{ localId: boxId, key: 'speed', value: 7.25 }] });
    const mapping = inst.body.change.mapping;
    const rootId = String(inst.body.change.rootId);
    const newBoxId = mapping.find((m) => m.localId === boxId).entityId;
    const obs = await cmd.query('queryEntities', { limit: 256, offset: 0 });
    const copyBox = obs.body.entities.find((e) => e.id === newBoxId);
    const overrideOk = copyBox.components.behavior.values.speed === 7.25 && copyBox.components.behavior.values.target === rootId;
    const second = await cmd.run('instantiatePrefab', { prefabId });
    const secondBoxId = second.body.change.mapping.find((m) => m.localId === boxId).entityId;
    record('A05.prefab', capture.status === 200 && inst.status === 200 && overrideOk && secondBoxId !== newBoxId ? 'PASS' : 'FAIL',
      `capture=${capture.status} instantiate=${inst.status} mapping=${mapping.map((m) => m.localId + '->' + m.entityId).join(',')} overrideOk=${overrideOk} copiesIndependent=${secondBoxId !== newBoxId}`);

    // A06 invalid captures rejected atomically
    const envPath = join(DATA, 'projects', M2_PROJECT, 'scenes/main.json');
    const envBefore = fileHash(envPath);
    const revBefore = cmd.state.revision;
    const camera = await cmd.run('createPrefab', { prefabId: 'prefab-0002', displayName: 'Camera cap', sourceEntityId: 'cam-main' });
    const unknown = await cmd.run('instantiatePrefab', { prefabId, overrides: [{ localId: boxId, key: 'nope', value: 1 }] });
    const envAfter = fileHash(envPath);
    const revAfter = await cmd.queryRevision();
    record('A06.prefab-reject', camera.status !== 200 && unknown.status !== 200 && envBefore === envAfter && revBefore === revAfter ? 'PASS' : 'FAIL',
      `cameraCapture=${camera.body?.error?.code ?? camera.status} unknownOverride=${unknown.body?.error?.code ?? unknown.status} atomicallyUnchanged=${envBefore === envAfter && revBefore === revAfter}`);

    // A07 MCP typed edit + stale conflict + projection convergence
    const mcp = await createMcp(M2_PROJECT);
    const tools = await mcp.listTools();
    const before = await mcp.call('tl_inspect', { target: 'entity', entityId: newBoxId });
    const revNow = cmd.state.revision;
    const mcpEdit = await mcp.call('tl_command', { op: 'setBehaviorProperties', expectedRevision: revNow, args: { entityId: newBoxId, behaviorId: 'behavior-0001', values: { speed: 1.5, target: null } } });
    cmd.state.revision = Number(mcpEdit.body.revision);
    const afterEdit = await mcp.call('tl_inspect', { target: 'entity', entityId: newBoxId });
    const stale = await mcp.call('tl_command', { op: 'setTransform', expectedRevision: 0, args: { entityId: newBoxId, transform: { position: [9, 9, 9] } } });
    const applied = editor.events.some((e) => e.type === 'mutation.applied' && JSON.stringify(e.change).includes(newBoxId));
    record('A07.mcp-property', mcpEdit.body.ok === true && stale.isError && stale.body.error.code === 'revision_conflict' && afterEdit.body.entity.components.behavior.values.speed === 1.5 && applied ? 'PASS' : 'FAIL',
      `tools=${tools.length} editSpeed=${afterEdit.body.entity.components.behavior.values.speed} stale=${stale.body.error.code} mutationAppliesConverged=${applied}`);
    writeEvidence('04-prefabs-properties.json', { prefabId, mapping, overrideOk, staleCode: stale.body.error.code, applied });
    await mcp.close();
  }

  // A15/A16 behavior publish/trust/compile + hostile rejection
  phase('A15/A16 behavior build, trust, execution, negatives');
  let behaviorSourceDigest = '';
  let behaviorOutputDigest = '';
  {
    const decl = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 3.5, min: -1000, max: 1000, step: 0.25 }] };
    const container = fixtureBytes('behaviors/valid/sample.json');
    const published = await publishBehaviorSource(bp, M2_PROJECT, cmd, 'behavior-0002', decl, container);
    behaviorSourceDigest = published.sourceDigest;
    behaviorOutputDigest = published.outputDigest;
    // attach the published behavior to the first placement so it is reachable
    await cmd.run('setBehaviorProperties', { entityId: placements[0], behaviorId: 'behavior-0002', values: { speed: 2 } });
    const list = await cmd.query('queryBehaviors', { limit: 128, offset: 0, includeDeclaration: true });
    const rec = list.body.behaviors.find((b) => b.behaviorId === 'behavior-0002');
    const recSourceDigest = String(rec.source?.sourceDigest ?? rec.sourceDigest ?? '');
    const sourceOk = recSourceDigest === behaviorSourceDigest;
    const hostile = fixtureBytes('behaviors/hostile/network.json');
    const hStage = await stageAndUpload(bp, M2_PROJECT, hostile);
    await cmd.run('acknowledgeBehaviorTrust', { sourceDigest: sha256Hex(hostile) });
    const hRes = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/content/behaviors/source`, {
      token: AUTH_TOKEN, origin: AUTHORING_ORIGIN,
      body: { stageId: hStage.stageId, behaviorId: 'behavior-0002', displayName: 'Hostile', declaration: decl, expectedRevision: cmd.state.revision, requestId: mkRequestId() },
    });
    const trustText = readFileSync(join(REPO, 'packages/runtime/src/behavior.ts'), 'utf8');
    const noticeOk = /no hard|trusted main thread|trusted-main-thread/i.test(trustText);
    const behaviorStill = (await cmd.query('queryBehaviors', { limit: 128, offset: 0, includeDeclaration: true })).body.behaviors.find((b) => b.behaviorId === 'behavior-0002');
    const stillDigest = String(behaviorStill.source?.sourceDigest ?? behaviorStill.sourceDigest ?? '');
    record('A15/A16.behavior', hRes.status !== 200 && sourceOk && behaviorOutputDigest.length === 64 && noticeOk && stillDigest === behaviorSourceDigest ? 'PASS' : 'FAIL',
      `sourceDigest=${behaviorSourceDigest.slice(0, 16)}… outputDigest=${behaviorOutputDigest.slice(0, 16)}… sourceRecorded=${sourceOk} hostile=${hRes.status}${hRes.body?.error?.code ? '/' + hRes.body.error.code : ''} oldPublicationRetained=${stillDigest === behaviorSourceDigest} trustNoticeTextPresent=${noticeOk}`);
    writeEvidence('05-behavior.json', { behaviorSourceDigest, behaviorOutputDigest, sourceOk, hostileStatus: hRes.status, hostileError: hRes.body?.error ?? null, stillDigest, trustNoticeTextPresent: noticeOk });
  }

  // course (floor + controller) so play/export have a real physics scene
  {
    const floor = await cmd.run('createEntity', { kind: 'group', name: 'Floor', parentId: null, transform: { position: [0, -0.25, 0] } });
    const floorId = String(floor.body.createdId);
    await cmd.run('setComponent', { entityId: floorId, component: 'collider', value: { shape: { type: 'box', hx: 10, hy: 0.25 } } });
    const character = await cmd.run('createEntity', { kind: 'group', name: 'Character', parentId: null, transform: { position: [-2, 0.9, 0] } });
    const characterId = String(character.body.createdId);
    await cmd.run('setComponent', { entityId: characterId, component: 'controller', value: {} });
    await cmd.run('setBehaviorProperties', { entityId: characterId, behaviorId: 'behavior-0002', values: { speed: 4 } });
  }

  // A17/A18/A19/A20 play: locator, pinning, MCP relay, security, lifecycle
  phase('A17/A18/A19/A20 play delivery, pinning, MCP relay, security, lifecycle');
  {
    const startPlay = async () => {
      for (let i = 0; i < 3; i += 1) {
        const res = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: { options: { demo: false } } });
        if (res.status === 200) return res.body;
        if (res.body?.error?.code === 'play_already_active' && res.body.error.activePlaySessionId) {
          await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play/${res.body.error.activePlaySessionId}/stop`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
          continue;
        }
        throw new Error(`play start failed ${res.status} ${JSON.stringify(res.body)}`);
      }
      throw new Error('play start retries exhausted');
    };
    const play = await startPlay();
    const locatorPath = play.playContent.path;
    const manifestRes = await http(`${PREVIEW_ORIGIN}${locatorPath}manifest.json`);
    const manifest = manifestRes.body;
    const manifestFrozenBefore = sha256Hex(manifestRes.bytes);

    // A17: a real scene/content change during play → running play pinned; fresh play adopts
    await cmd.run('setTransform', { entityId: placements[0], transform: { position: [0.5, 0, 0] } });
    const manifestDuring = await http(`${PREVIEW_ORIGIN}${locatorPath}manifest.json`);
    const pinned = sha256Hex(manifestDuring.bytes) === manifestFrozenBefore;
    // locator serves declared artifacts with digests
    const asset = manifest.assets[0];
    const assetRes = await http(`${PREVIEW_ORIGIN}${locatorPath}${asset.path}`);
    const assetDigestOk = sha256Hex(assetRes.bytes) === asset.sourceDigest;
    // security negatives
    const traversal = await http(`${PREVIEW_ORIGIN}/play-content/${play.playContent.contentId}/..%2f..%2fetc%2fpasswd`);
    const undeclared = await http(`${PREVIEW_ORIGIN}/play-content/${play.playContent.contentId}/secrets.txt`);
    const other = await http(`${PREVIEW_ORIGIN}/play-content/${'z'.repeat(43)}/manifest.json`);
    const listed = await http(`${PREVIEW_ORIGIN}/play-content/`);
    const redacted = !JSON.stringify(undeclared.body).includes(play.playContent.contentId);
    // A19 MCP relay through the deployed stdio MCP with the editor stub
    const mcp = await createMcp(M2_PROJECT);
    const unknownPlay = await mcp.call('tl_input_exercise', {
      playSessionId: `play-${'0'.repeat(32)}`,
      frames: [{ stepOffset: 0, moveX: 0, jump: 'none' }],
    });
    const relay = await mcp.call('tl_input_exercise', {
      playSessionId: play.playSessionId,
      frames: [
        { stepOffset: 0, moveX: 1, jump: 'none' },
        { stepOffset: 1, moveX: 1, jump: 'pressed' },
        { stepOffset: 2, moveX: 0, jump: 'released' },
      ],
    });
    const relayOk = relay.body.ok === true && relay.body.appliedFromStep === 100 && relay.body.appliedToStep === 102 && relay.body.inputMode === 'test' && relay.body.buildId === play.playContent.buildId;
    // An unknown play is a STRUCTURED failure, never a simulated success. (The
    // real no-browser `session_unavailable` negative is a package test:
    // packages/backend/src/play.test.ts + packages/mcp-adapter/src/mcp.e2e.test.ts.)
    // fresh play adopts the new revision/build
    await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play/${play.playSessionId}/stop`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
    await sleep(200);
    const fresh = await startPlay();
    const freshManifest = await http(`${PREVIEW_ORIGIN}${fresh.playContent.path}manifest.json`);
    // A20: five repeated start/stop cycles. Each stop must complete cleanly: the
    // stop route returns 200 {ok:true} AND the owner ack drives `play.stopped`
    // with reason "request" and WITHOUT `stopUnconfirmed` (a stop-ack timeout
    // sets that flag). The response status is asserted, not only the counter.
    const stopResults = [];
    const stopEvents = [];
    const waitForStopEvent = async (playSessionId, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const ev = editor.events.find((e) => e.type === 'play.stopped' && e.playSessionId === playSessionId);
        if (ev !== undefined) return ev;
        if (Date.now() >= deadline) return null;
        await sleep(25);
      }
    };
    const stopAndConfirm = async (playSessionId) => {
      const res = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play/${playSessionId}/stop`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
      stopResults.push({ playSessionId, status: res.status, ok: res.body?.ok === true });
      const ev = await waitForStopEvent(playSessionId);
      if (ev !== null) stopEvents.push(ev);
      return res;
    };
    await stopAndConfirm(fresh.playSessionId);
    await sleep(60);
    let cycles = 0;
    for (let i = 0; i < 5; i += 1) {
      const p = await startPlay();
      cycles += 1;
      await stopAndConfirm(p.playSessionId);
      await sleep(60);
    }
    const stopResponsesOk = stopResults.length === 6 && stopResults.every((s) => s.status === 200 && s.ok === true);
    const stopsConfirmed =
      stopEvents.length === stopResults.length &&
      stopEvents.every((e) => e.stopUnconfirmed !== true && e.reason === 'request') &&
      new Set(stopEvents.map((e) => e.playSessionId)).size === stopResults.length;
    record('A17.play-pinning', pinned && assetDigestOk && fresh.playContent.buildId !== play.playContent.buildId ? 'PASS' : 'FAIL',
      `manifestFrozenDuringPlay=${pinned} assetDigestOk=${assetDigestOk} playBuild=${play.playContent.buildId.slice(0, 12)}… freshBuild=${fresh.playContent.buildId.slice(0, 12)}… freshAdoptsNewRevision=${fresh.revision > play.revision}`);
    record('A18.delivery-security', traversal.status === 400 && undeclared.status === 400 && other.status === 404 && listed.status === 400 && redacted ? 'PASS' : 'FAIL',
      `traversal=${traversal.status} undeclared=${undeclared.status} foreignContent=${other.status} listing=${listed.status} capabilityRedacted=${redacted}`);
    record('A19.mcp-relay', relayOk && unknownPlay.isError ? 'PASS' : 'FAIL',
      `relay=${JSON.stringify(relay.body)} unknownPlayIsError=${unknownPlay.isError} unknownPlayCode=${unknownPlay.body?.error?.code ?? ''}`);
    record('A20.lifecycle', cycles === 5 && stopResponsesOk && stopsConfirmed ? 'PASS' : 'FAIL',
      `repeated start/stop cycles=${cycles} stopStatuses=${stopResults.map((s) => s.status).join('/')} stopResponsesOk=${stopResponsesOk} ownerStoppedEvents=${stopEvents.length} stopUnconfirmed=${stopEvents.filter((e) => e.stopUnconfirmed === true).length} allStopsConfirmedRequestReason=${stopsConfirmed}`);
    const redactedPlay = { ...play, playContent: { ...play.playContent, contentId: '<redacted-capability>', path: '/play-content/<redacted-capability>/' } };
    writeEvidence('06-play.json', { play: redactedPlay, pinned, assetDigestOk, security: { traversal: traversal.status, undeclared: undeclared.status, other: other.status, listed: listed.status, redacted }, relay: relay.body, fresh: { buildId: fresh.playContent.buildId, revision: fresh.revision }, lifecycle: { cycles, stopResults, stopEvents } });
    await mcp.close();
  }

  // ---------------- A09 crash / takeover / retry / stage replay -------------
  phase('A09 crash, takeover, retry, expired stage replay');
  {
    const envPath = join(DATA, 'projects', M2_PROJECT, 'scenes/main.json');
    const ackedRequestId = mkRequestId();
    const revBeforeAcked = cmd.state.revision;
    const acked = await cmd.run('createEntity', { kind: 'box', name: 'Durable Box', parentId: null }, { requestId: ackedRequestId });
    const revAcked = Number(acked.body.revision);
    const ackedEntityId = String(acked.body.createdId);
    const hashAcked = fileHash(envPath);
    // open a stage, then kill the backend before completing it
    const stageRes = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/content/stages`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
    const orphanStage = stageRes.body.stageId;
    await stopBackend(bp, 'SIGKILL');
    say(`backend SIGKILLed (pid ${bp.proc.pid})`);
    bp = await startBackend('boot-2');
    // the authoring session died with the process; the stale ownership record is explicit
    const staleEstablish = await tryEstablish(M2_PROJECT);
    const staleCode = staleEstablish.ok ? null : (staleEstablish.body?.error?.reason ?? staleEstablish.body?.error?.code ?? 'unknown');
    let takeoverStatus = null;
    if (!staleEstablish.ok) {
      const tr = await http(`${AUTHORING_ORIGIN}/api/v1/admin/projects/${M2_PROJECT}/takeover`, { token: ADMIN_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
      takeoverStatus = tr.status;
    }
    await establish(M2_PROJECT);
    cmd.state.revision = await cmd.queryRevision();
    const afterTakeover = await cmd.run('createEntity', { kind: 'box', name: 'After takeover', parentId: null });
    // replay the acked requestId → duplicated, identical result
    const replay = await cmd.run('createEntity', { kind: 'box', name: 'Durable Box', parentId: null }, { requestId: ackedRequestId, expectedRevision: revBeforeAcked });
    const durable = (await cmd.query('queryEntities', { limit: 256, offset: 0 })).body.entities.some((e) => e.id === ackedEntityId);
    const takeoverOk = staleEstablish.ok ? true : takeoverStatus === 200;
    record('A09.crash', takeoverOk && afterTakeover.status === 200 && replay.body?.duplicated === true && durable ? 'PASS' : 'FAIL',
      `preCrashAckedRevision=${revAcked} (from ${revBeforeAcked}) preCrashEntity=${ackedEntityId} staleOwnershipAfterRestart=${staleCode ?? '(none)'} takeoverStatus=${takeoverStatus ?? '(not required)'} postRecoveryCommand=${afterTakeover.status} retryDuplicated=${replay.body?.duplicated} durableEntityPresent=${durable} orphanStage=${orphanStage}`);
    writeEvidence('07-crash-takeover.json', { revBeforeAcked, revAcked, ackedEntityId, staleCode: staleCode ?? null, staleError: staleEstablish.ok ? null : staleEstablish.body?.error ?? null, takeoverStatus, afterTakeover: afterTakeover.status, replay: replay.body, replayDuplicated: replay.body?.duplicated, durable, orphanStage });
  }

  // ---------------- A10 tamper / missing / derived cache / backup -----------
  phase('A10 tamper, missing source, derived cache, source backup/restore');
  {
    const blobDir = join(DATA, 'projects', M2_PROJECT, 'sources/sha256');
    const blobPath = join(blobDir, glbV1Digest);
    const original = readFileSync(blobPath);
    // derived cache deletion is recoverable
    const derived = join(DATA, 'projects', M2_PROJECT, '.thirdlight/derived');
    let derivedExisted = existsSync(derived);
    if (derivedExisted) rmSync(derived, { recursive: true, force: true });
    const afterCache = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/commands`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: { op: 'queryProject', projectId: M2_PROJECT, args: {} } });
    // tamper
    const tampered = Buffer.from(original);
    tampered[0] = tampered[0] ^ 0xff;
    writeFileSync(blobPath, tampered);
    const mcp = await createMcp(M2_PROJECT);
    const integrityTamper = await mcp.call('tl_content_query', { target: 'integrity' });
    const tamperText = JSON.stringify(integrityTamper.body).toLowerCase();
    const tamperDetected = tamperText.includes('corrupt') || tamperText.includes('tamper') || tamperText.includes('digest_mismatch');
    writeFileSync(blobPath, original);
    // missing source
    rmSync(blobPath);
    const integrityMissing = await mcp.call('tl_content_query', { target: 'integrity' });
    const missingDetected = JSON.stringify(integrityMissing.body).toLowerCase().includes('missing');
    await mcp.close();
    writeFileSync(blobPath, original);
    // source backup/restore retains playable content
    const backupDir = join(ROOT, 'source-backup');
    cpSync(join(DATA, 'projects', M2_PROJECT, 'sources'), backupDir, { recursive: true });
    rmSync(join(DATA, 'projects', M2_PROJECT, 'sources'), { recursive: true, force: true });
    cpSync(backupDir, join(DATA, 'projects', M2_PROJECT, 'sources'), { recursive: true });
    const restoredOk = existsSync(blobPath) && sha256Hex(new Uint8Array(readFileSync(blobPath))) === glbV1Digest;
    const healPlay = await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: { options: { demo: false } } });
    if (healPlay.status === 200) {
      await http(`${AUTHORING_ORIGIN}/api/v1/projects/${M2_PROJECT}/play/${healPlay.body.playSessionId}/stop`, { token: AUTH_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
    }
    record('A10.durability', (derivedExisted ? afterCache.status === 200 : afterCache.status === 200) && tamperDetected && missingDetected && restoredOk && healPlay.status === 200 ? 'PASS' : 'FAIL',
      `derivedExisted=${derivedExisted} cacheDeletionRecoverable=${afterCache.status === 200} tamperDetected=${tamperDetected} missingDetected=${missingDetected} restoredByteExact=${restoredOk} freshPlayAfterRestore=${healPlay.status}`);
    writeEvidence('08-durability.json', { derivedExisted, cacheRecoverable: afterCache.status === 200, tamperDetected, integrityTamper, missingDetected, integrityMissing: integrityMissing.body, restoredOk, freshPlayAfterRestore: healPlay.status });
  }

  // ---------------- A21/A22/A23 export + static serving ---------------------
  phase('A21/A22/A23 export, reproducibility, failure isolation, static serving');
  {
    const runExport = async () => {
      const res = await http(`${AUTHORING_ORIGIN}/api/v1/admin/projects/${M2_PROJECT}/export`, { token: ADMIN_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
      return { status: res.status, body: res.body };
    };
    // A22: two genuinely separate exports into DISTINCT disposable output
    // roots. Export 1 uses the running backend (`THIRDLIGHT_EXPORT_ROOT`
    // = EXPORTS); the backend is then restarted with a second disposable
    // export root and export 2 runs there. `outputDir` is deterministic per
    // (project, revision), so two roots are the only way both trees can
    // coexist for an honest before/after comparison — no directory is hashed
    // twice.
    const EXPORTS2 = join(ROOT, 'exports-2');
    const e1 = await runExport();
    const ok1 = e1.status === 200 && e1.body.ok === true;
    const t1 = ok1 ? join(EXPORTS, String(e1.body.outputDir)) : null;
    await stopBackend(bp, 'SIGTERM');
    bp = await startBackend('boot-export-2', EXPORTS2);
    // The SIGTERM'd process held the project's ownership record; the export path
    // reads the workspace, so the stale claim it left behind must be explicitly
    // taken over (never automatic) before export 2 can run — the same operator
    // action the A09 crash step exercises.
    const export2Pre = await tryEstablish(M2_PROJECT);
    let export2TakeoverStatus = null;
    if (!export2Pre.ok && export2Pre.body?.error?.reason === 'stale_ownership') {
      const tr = await http(`${AUTHORING_ORIGIN}/api/v1/admin/projects/${M2_PROJECT}/takeover`, { token: ADMIN_TOKEN, origin: AUTHORING_ORIGIN, body: {} });
      export2TakeoverStatus = tr.status;
    }
    await establish(M2_PROJECT);
    await sleep(1100);
    const e2 = await runExport();
    const ok2 = e2.status === 200 && e2.body.ok === true;
    const t2 = ok2 ? join(EXPORTS2, String(e2.body.outputDir)) : null;
    let sameTree = false;
    let differing = [];
    let timestampOnly = false;
    let nonTimestampIdentical = false;
    let rederivedBuildIdMatchesFirst = false;
    let manifest = null;
    let manifest1 = null;
    let staticOk = false;
    let mimeOk = false;
    if (ok1 && ok2) {
      const h1 = hashTree(t1);
      const h2 = hashTree(t2);
      const files1 = Object.keys(h1).sort();
      const files2 = Object.keys(h2).sort();
      sameTree = JSON.stringify(files1) === JSON.stringify(files2);
      differing = files1.filter((k) => h1[k] !== h2[k]);
      manifest1 = JSON.parse(readFileSync(join(t1, 'manifest.json'), 'utf8'));
      manifest = JSON.parse(readFileSync(join(t2, 'manifest.json'), 'utf8'));
      // A22: the ONLY permitted differences are the agreed timestamp carriers
      // (`manifest.json` capturedAt→buildId, `meta.json` exportedAt→buildId/
      // outputDigest). Normalising capturedAt and re-deriving buildId must make
      // the second manifest match the first export's buildId (C36-7, accepted
      // with diff).
      timestampOnly = differing.every((f) => f === 'manifest.json' || f === 'meta.json');
      nonTimestampIdentical = files1
        .filter((f) => f !== 'manifest.json' && f !== 'meta.json')
        .every((f) => h1[f] === h2[f]);
      const normalized = { ...manifest, capturedAt: manifest1.capturedAt };
      delete normalized.buildId;
      const rederivedBuildId = createHash('sha256').update(`${JSON.stringify(normalized, null, 2)}\n`).digest('hex');
      rederivedBuildIdMatchesFirst = rederivedBuildId === manifest1.buildId;
      // A23: failure isolation — remove a source blob then export must fail and leave output untouched
      const beforeTree = hashTree(t2);
      const blobDir = join(DATA, 'projects', M2_PROJECT, 'sources/sha256');
      const referencedDigest = manifest.assets[0].path.split('/').pop();
      const saved = readFileSync(join(blobDir, referencedDigest));
      rmSync(join(blobDir, referencedDigest));
      const failed = await runExport();
      writeFileSync(join(blobDir, referencedDigest), saved);
      const afterTree = hashTree(t2);
      const isolated = failed.body?.ok === false && JSON.stringify(beforeTree) === JSON.stringify(afterTree);
      // static serving under a non-root subpath with the backend STOPPED
      await stopBackend(bp, 'SIGTERM');
      const server = await startStaticServer(t2, `/games/${e2.body.outputDir}/`);
      const index = await http(`${server.origin}/games/${e2.body.outputDir}/index.html`);
      const mres = await http(`${server.origin}/games/${e2.body.outputDir}/manifest.json`);
      const sres = await http(`${server.origin}/games/${e2.body.outputDir}/scene.json`);
      const assetPath = manifest.assets[0].path;
      const ares = await http(`${server.origin}/games/${e2.body.outputDir}/${assetPath}`);
      const bres = await http(`${server.origin}/games/${e2.body.outputDir}/${manifest.behaviors[0].path}`);
      staticOk = index.status === 200 && mres.status === 200 && sres.status === 200 && ares.status === 200 && bres.status === 200;
      mimeOk = ares.headers['content-type'] === 'model/gltf-binary' && bres.headers['content-type'].includes('javascript');
      record('A21/A23.export', sameTree && isolated && staticOk && mimeOk && server.externalRequests === 0 ? 'PASS' : 'FAIL',
        `export1=${e1.status} export2=${e2.status} exportRootsDistinct=${EXPORTS !== EXPORTS2} sameFileSet=${sameTree} differing=${differing.join(',') || '(none)'} failureIsolated=${isolated} backendsStoppedStaticServe=${staticOk} mime=${mimeOk} externalRequests=${server.externalRequests} files=${Object.keys(hashTree(t2)).length}`);
      record('A22.reproducibility', sameTree && timestampOnly && nonTimestampIdentical && rederivedBuildIdMatchesFirst ? 'PASS' : 'FAIL',
        `exportRoot1=${EXPORTS} exportRoot2=${EXPORTS2} fileSetsEqual=${sameTree} files=${Object.keys(h1).length} differing=${differing.join(',') || '(none)'} timestampCarriersOnly=${timestampOnly} nonTimestampBytesIdentical=${nonTimestampIdentical} buildIdEqual=${e1.body.buildId === e2.body.buildId} capturedAt1=${manifest1.capturedAt} capturedAt2=${manifest.capturedAt} rederivedBuildIdMatchesFirst=${rederivedBuildIdMatchesFirst}`);
      writeEvidence('09-export.json', { e1: e1.body, e2: e2.body, exportRoots: { first: EXPORTS, second: EXPORTS2 }, export2TakeoverStatus, tree1Hash: h1, tree2Hash: h2, differing, sameTree, timestampOnly, nonTimestampIdentical, rederivedBuildIdMatchesFirst, capturedAt1: manifest1.capturedAt, capturedAt2: manifest.capturedAt, manifest, staticOk, mimeOk, externalRequests: server.externalRequests, serverRequests: server.requests });
      await server.close();
    } else {
      record('A21/A23.export', 'FAIL', `export1=${e1.status} ${JSON.stringify(e1.body?.error ?? e1.body)} export2=${e2.status} ${JSON.stringify(e2.body?.error ?? e2.body)}`);
    }
  }

  // ---------------- A24 clean install / boundaries / pins -------------------
  phase('A24 clean-install, boundaries, pins');
  {
    const pins = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
    const pick = (name) => pins.packages[`node_modules/${name}`];
    const pinSummary = {
      three: pick('three')?.version,
      esbuild: pick('esbuild')?.version,
      typescript: pick('typescript')?.version,
      vitest: pick('vitest')?.version,
      ws: pick('ws')?.version,
      rapier: pick('@dimforge/rapier2d-compat')?.version,
      mcp: pick('@modelcontextprotocol/sdk')?.version,
    };
    record('A24.pins', Object.values(pinSummary).every((v) => typeof v === 'string') ? 'PASS' : 'FAIL', JSON.stringify(pinSummary));
    writeEvidence('10-pins.json', pinSummary);
  }

  // ---------------- summary -------------------------------------------------
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  say(`\n## summary`);
  say(`- results: ${JSON.stringify(counts)}`);
  writeEvidence('results.json', { root: ROOT, results, counts });
  writeEvidence('transcript.md', log.join('\n'));
  await editor.close();
  if (bp.proc.exitCode === null) await stopBackend(bp, 'SIGTERM');
  say(`disposable root retained for inspection: ${ROOT}`);
}

main().catch((err) => {
  record('journey.fatal', 'FAIL', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  try {
    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    writeEvidence('results.json', { root: ROOT, results, counts });
    writeEvidence('transcript.md', log.join('\n'));
  } catch {
    /* best effort */
  }
  process.exitCode = 1;
});
