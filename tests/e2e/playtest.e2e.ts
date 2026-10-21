/**
 * The headless play-test runner — the CLI (`tools/playtest.mjs`)
 * against a real backend with no editor open (the backend plays in its
 * headless editor), and `tl_playtest` through the real MCP stdio adapter.
 *
 * The project is neutral and generated here: a game folder made from the
 * starter template (`POST /admin/projects {folder, template}`), a probe
 * script that shows what `ctx.save` holds for the start variable `probe` in
 * the UI view model and then changes it (so a run that did not begin with
 * the start's variables sees another value), and, for the CLI's driver run,
 * a driver module in the game folder that walks the character until it is
 * three metres on, deciding every ten steps from the observation.
 *
 * Checked: the same input script twice gives the same run digests at the
 * same run steps, in the simulation worker and on a single thread (four runs
 * agree; through MCP, with a second player controller, three runs in each); an observation in the middle of a run is step-exact (the script
 * is split into exercises that hold the game in between); the start's
 * variables apply at every start: each run's restart and a game shell's New
 * game; the driver's runs agree too; the two walks of one run, each from
 * rest, cover the same distance; a script that throws is switched off while
 * the game runs on, listed once with its source line and in the Problems, and
 * a play-test finishes with it among the run's errors; tl_diagnostics and
 * tl_game_observe answer only the sections asked for.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { GAME_OBSERVATION_HEADER, GAME_OBSERVATION_SECTIONS } from '@thirdlight/protocol';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from './pw';

import { STARTER, type E2EBackend, startBackend } from './backend';
// @ts-expect-error — a plain .mjs helper shared with the Playwright config
import { browserLibs } from './browser-env.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let scratch: string;
test.beforeEach(async () => {
  const libs = browserLibs() as string | undefined;
  be = await startBackend('playtest-e2e', 'starter', { THIRDLIGHT_HEADLESS: 'on', ...(libs !== undefined ? { THIRDLIGHT_BROWSER_LIBS: libs } : {}) });
  scratch = mkdtempSync(join(tmpdir(), 'tl-playtest-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The probe: what ctx.save holds for `probe` this step (t.seen), then one more (so a run not begun with the start's
 * variables sees more). With the start variable `boom` (a number) it throws after that many steps of a run.
 */
const PROBE = [
  'export default {',
  '  instantiate() { return { shown: false, n: 0 }; },',
  '  step(s: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    const boom = ctx.save.get('boom');",
  "    if (typeof boom === 'number' && ++s.n > boom) throw new Error('boom: the probe threw');",
  "    if (!s.shown) s.shown = ctx.ui.show('hud');",
  "    const v = ctx.save.get('probe');",
  "    ctx.ui.set('t.seen', typeof v === 'number' ? v : -1);",
  "    if (typeof v === 'number') ctx.save.set('probe', v + 1);",
  '  },',
  '};',
  '',
].join('\n');

/** Commands and routes of one project of the backend. */
function projectApi(projectId: string) {
  const headers = { authorization: `Bearer ${be.token}`, origin: be.origin };
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${projectId}/${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const envelope = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => (await post('commands', { ...body, projectId })).json;
  const revision = async (): Promise<number> => Number((await envelope({ op: 'queryProject', args: {} })).revision);
  const cmd = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const res = await envelope({ op, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-playtest' }, args });
    expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  };
  /** The probe script on the character and the HUD document it shows. */
  const setUp = async (): Promise<void> => {
    const behaviorId = 'behavior-playtest-probe';
    const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: PROBE }] }, null, 2)}\n`);
    const stageId = String((await post('content/stages', {})).json.stageId);
    const put = await fetch(`${be.origin}/api/v1/projects/${projectId}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const declaration = { properties: [] };
    await cmd('publishBehavior', { behaviorId, displayName: 'Playtest probe', mode: 'declaration-create', declaration });
    await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
    const published = await post('content/behaviors/source', { stageId, behaviorId, displayName: 'Playtest probe', declaration, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
    expect(published.status, JSON.stringify(published.json)).toBe(200);
    await cmd('setBehaviorProperties', { entityId: STARTER.playerId, behaviorId, values: {} });
    await cmd('setUiDocument', { document: { uiDocumentId: 'hud', name: 'HUD', root: { type: 'panel', stretch: 'both', children: [{ id: 'seen', type: 'text', text: '{t.seen}', anchor: [0, 0], pivot: [0, 0], offset: [12, 12] }] } } });
  };
  return { cmd, setUp };
}

interface Observation {
  runStep: number;
  digest: string;
  fields: Record<string, unknown>;
}
interface Run {
  threads: string;
  run: number;
  simulation: string | null;
  observations: Observation[];
  runStep: number;
  digest: string;
  result?: { steps: number; dx: number };
  trace?: { exercises: number; digest: string };
  log?: string[];
  errors?: Record<string, unknown>[];
  errorCount: number;
  errors: unknown[];
}
interface Result {
  ok: boolean;
  error?: unknown;
  input: { kind: string; steps?: number; exercises?: number };
  runs: Run[];
  deterministic: boolean;
  mismatches: string[];
}

/** Run the CLI; returns its exit status and parsed JSON. */
function cli(args: string[]): Promise<{ status: number | null; result: Result; stderr: string }> {
  const tokenFile = join(scratch, 'token');
  writeFileSync(tokenFile, be.token, { mode: 0o600 });
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [join(REPO, 'tools', 'playtest.mjs'), ...args, '--origin', be.origin, '--token-file', tokenFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', fail);
    child.once('exit', (status) => {
      try {
        ok({ status, result: JSON.parse(out) as Result, stderr: err });
      } catch {
        fail(new Error(`playtest printed no JSON (exit ${String(status)}): ${err.slice(0, 2000)} ${out.slice(0, 500)}`));
      }
    });
  });
}

const walk = (stepOffset: number, steps: number, v = 1) => ({ stepOffset, steps, actions: { move: { v, p: 'none' } } });
const seen = (o: Observation): number => Number((o.fields['ui.values'] as { t?: { seen?: number } } | null)?.t?.seen);
const x = (o: Observation): number => (o.fields['player'] as { x: number }).x;

// The worker only: the CLI's `--threads both` (and the two modes agreeing) is the MCP test's below, and relay-input's.
test('the CLI plays an input script twice: the same run digests; start variables at every run; each walk from rest covers the same distance', async () => {
  test.setTimeout(300_000);
  const folder = join(scratch, 'game');
  const created = await be.admin('projects', { projectId: 'playtest-folder', name: 'Playtest', folder, template: 'starter' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const folderApi = projectApi('playtest-folder');
  await folderApi.setUp();
  // Clear the way on the right (the starter's low step at x 6-7 would stop the second walk).
  await folderApi.cmd('deleteEntity', { entityId: 'box-0002' });

  // Rest, walk 90 steps, rest, walk 90 steps, rest, a jump walking, rest; observed at 60, 300, 540 and the end (660). Each rest
  // is 150 steps: the character stops within a few steps of letting go (its deceleration), so each walk starts from rest.
  const script = [walk(60, 90), walk(300, 90), { stepOffset: 560, actions: { move: { v: 1, p: 'none' }, jump: { v: 1, p: 'pressed' } } }, walk(561, 29), { stepOffset: 659 }];
  writeFileSync(join(scratch, 'script.json'), JSON.stringify({ frames: script }));
  writeFileSync(join(scratch, 'vars.json'), JSON.stringify({ probe: 7 }));
  const { status, result, stderr } = await cli([folder, '--input', join(scratch, 'script.json'), '--variables', join(scratch, 'vars.json'), '--threads', 'worker', '--runs', '2', '--at', '60,300,540', '--fields', 'player,ui.values,state']);
  expect(result.ok, `${stderr} ${JSON.stringify(result).slice(0, 2000)}`).toBe(true);
  expect(status).toBe(0);
  expect(result.input).toMatchObject({ kind: 'frames', steps: 660 });
  expect(result.runs.map((r) => `${r.threads}/${r.simulation}/${r.run}`)).toEqual(['worker/worker/1', 'worker/worker/2']);
  // The same input twice: the same digests at the same run steps.
  expect(result.deterministic, JSON.stringify(result.mismatches)).toBe(true);
  for (const r of result.runs) {
    expect(r.observations.map((o) => o.runStep)).toEqual([60, 300, 540, 660]);
    expect(r.observations.map((o) => o.digest)).toEqual(result.runs[0]!.observations.map((o) => o.digest));
    expect(r.errorCount, JSON.stringify(r.errors)).toBe(0);
    // Every run began with the start's variables (the probe counts up from 7 each step): t.seen = 6 + run step.
    for (const o of r.observations) expect(seen(o), JSON.stringify(o.fields)).toBe(6 + o.runStep);
  }
  const [at60, at300, at540, at660] = result.runs[0]!.observations as [Observation, Observation, Observation, Observation];
  expect(x(at660)).toBeGreaterThan(x(at540));
  // Walk-distance question: two walks of one run, each from rest (a restart only before the first). The runs above agree to the
  // bit, so the simulation is deterministic; two walks from different rests are not the same start — the character's height on the
  // ground differs (measured y 0.90982 sixty steps after the restart's placement, 0.91000 after the first walk) and so does x — so
  // they cover the same distance only to within a millimetre (measured 0.6 mm in 2.9 m), not to the bit.
  const first = x(at300) - x(at60);
  const second = x(at540) - x(at300);
  const y = (o: Observation): number => (o.fields['player'] as { y: number }).y;
  expect(first).toBeGreaterThan(2);
  expect(Math.abs(second - first), `first ${first} from y ${y(at60)}, second ${second} from y ${y(at300)}`).toBeLessThan(1e-3);

  // A driver of the game folder: walks until three metres on, deciding every ten steps from the observation.
  writeFileSync(
    join(folder, 'walk-driver.mjs'),
    [
      'export default async function drive(game) {',
      '  let o = await game.observe();',
      '  const x0 = o.player.x;',
      '  let steps = 0;',
      '  while (o.player.x < x0 + 3 && steps < 1200) {',
      "    o = await game.step([{ stepOffset: 0, steps: 10, actions: { move: { v: 1, p: 'none' } } }]);",
      '    steps += 10;',
      '  }',
      '  game.log(`walked in ${steps} steps (run ${game.run}, ${game.threads})`);',
      '  return { steps, dx: o.player.x - x0 };',
      '}',
      '',
    ].join('\n'),
  );
  const driven = await cli([folder, '--driver', 'walk-driver.mjs', '--threads', 'worker', '--runs', '2']);
  expect(driven.result.ok, `${driven.stderr} ${JSON.stringify(driven.result).slice(0, 2000)}`).toBe(true);
  expect(driven.status).toBe(0);
  expect(driven.result.deterministic, JSON.stringify(driven.result.mismatches)).toBe(true);
  expect(driven.result.runs).toHaveLength(2);
  const r0 = driven.result.runs[0]!;
  expect(r0.result!.dx).toBeGreaterThanOrEqual(3);
  expect(r0.result!.steps).toBeGreaterThan(10);
  expect(r0.trace!.exercises).toBe(r0.result!.steps / 10 + 1);
  for (const r of driven.result.runs) {
    expect(r.result).toEqual(r0.result);
    expect(r.trace).toEqual(r0.trace);
    expect(r.log).toEqual([`walked in ${r0.result!.steps} steps (run ${r.run}, ${r.threads})`]);
  }
});

test('tl_playtest through the MCP stdio adapter: a script whose run pauses and picks the shell\'s New game begins again with the start variables; drivers are the CLI\'s', async () => {
  test.setTimeout(240_000);
  const api = projectApi(be.projectId);
  await api.setUp();
  // A pause screen whose one (focused) button starts a new game.
  await api.cmd('setUiDocument', { document: { uiDocumentId: 'pause', name: 'Pause', root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', children: [{ id: 'again', type: 'button', size: [160, 40], text: 'New game', onClick: { do: 'engine', action: 'newGame' } }] } } });
  await api.cmd('setShell', { shell: { screens: { pause: 'pause' } } });
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  try {
    const call = async (args: Record<string, unknown>): Promise<{ isError: boolean; body: Result }> => {
      const res = (await mcp.callTool({ name: 'tl_playtest', arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Result };
    };
    // Walk 100 steps, pause (the shell's pause screen), New game (submit on its focused button), walk 60 more.
    const frames = [walk(0, 100), { stepOffset: 110, ui: ['pause'] }, { stepOffset: 140, ui: ['submit'] }, walk(170, 60), { stepOffset: 299 }];
    const r = await call({ frames, variables: { probe: 7 }, runs: 1, observe: { fields: ['ui.values', 'shell', 'state'] } });
    expect(r.isError, JSON.stringify(r.body).slice(0, 2000)).toBe(false);
    const end = r.body.runs[0]!.observations[0]!;
    // The New game restarted the run (its run steps count from there) and began it with the start variables again.
    expect(end.runStep).toBeLessThan(300);
    expect(end.runStep).toBeGreaterThan(100);
    expect(seen(end), JSON.stringify(end.fields)).toBe(6 + end.runStep);
    expect(end.fields['state']).toBe('running');

    // A second player controller as the co-op guide makes it (the Starter's character, animated, kept loaded; it reads the
    // same actions, so it walks and jumps too): every restart must put it back exactly as the first start did.
    const roles = { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } };
    await api.cmd('createEntity', {
      sceneId: 'scene-main',
      parentId: null,
      kind: 'model',
      name: 'Player 2',
      keepLoaded: true,
      transform: { position: [0, 0.91, 0] },
      model: { asset: { assetId: 'starter-character' } },
      components: { controller: {}, modelAnimation: { assetId: 'starter-character', version: 1, roles } },
    });
    // The same input three times, both threading modes, through MCP: the same digests.
    const plain = await call({ frames: [walk(0, 60), { stepOffset: 60, actions: { jump: { v: 1, p: 'pressed' } } }, walk(61, 60, -1)], threads: 'both', runs: 3, observe: { atSteps: [60] } });
    expect(plain.isError, JSON.stringify(plain.body).slice(0, 2000)).toBe(false);
    expect(plain.body.deterministic, JSON.stringify(plain.body.mismatches)).toBe(true);
    expect(plain.body.runs.map((x) => x.simulation)).toEqual(['worker', 'worker', 'worker', 'single', 'single', 'single']);
    expect(new Set(plain.body.runs.flatMap((x) => x.observations.map((o) => `${o.runStep}:${o.digest}`))).size).toBe(2);
    // Split into two exercises (held in between) or sent as one: the same run, step for step.
    const whole = await call({ frames: [walk(0, 60), { stepOffset: 60, actions: { jump: { v: 1, p: 'pressed' } } }, walk(61, 60, -1)], threads: 'worker', runs: 1 });
    expect(whole.isError, JSON.stringify(whole.body).slice(0, 2000)).toBe(false);
    expect(whole.body.input.exercises).toBe(1);
    expect(plain.body.input.exercises).toBe(2);
    expect(whole.body.runs[0]!.digest).toBe(plain.body.runs[0]!.digest);
    expect(whole.body.runs[0]!.runStep).toBe(121);

    // Drivers run from the command line (the project's own Node code); a bad script is refused before any play.
    const driver = await call({ driver: 'bot.mjs' });
    expect(driver.isError).toBe(true);
    expect(JSON.stringify(driver.body)).toContain('tools/playtest.mjs');
    const overlapping = await call({ frames: [walk(0, 10), walk(5, 10)] });
    expect(overlapping.isError).toBe(true);
    expect(JSON.stringify(overlapping.body)).toContain('playtest_invalid');

    // A script that throws is switched off and the game runs on: tl_game_observe keeps stepping, tl_diagnostics
    // lists the error once with its object and source line, the project's Problems name the script, and a
    // play-test finishes with the error among its run's errors.
    const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    };
    const started = await tool('tl_play_start', { demo: false, variables: { boom: 30 } });
    const playSessionId = String(started['playSessionId']);
    const scriptErrors = async (): Promise<Record<string, unknown>[]> => {
      const d = (await tool('tl_diagnostics', { playSessionId })) as { diagnostics?: { runtime?: { errors?: Record<string, unknown>[] } } };
      return (d.diagnostics?.runtime?.errors ?? []).filter((e) => e['code'] !== 'behavior_log');
    };
    await expect.poll(async () => (await scriptErrors()).length, { timeout: 60_000 }).toBe(1);
    const [thrown] = await scriptErrors();
    expect(thrown, JSON.stringify(thrown)).toMatchObject({ reason: 'behavior_step_failed', entityId: STARTER.playerId, message: expect.stringContaining('boom: the probe threw'), source: { behaviorId: 'behavior-playtest-probe', path: 'src/index.ts', line: 6 } });
    const obs = await tool('tl_game_observe', { playSessionId });
    expect(obs['state'], JSON.stringify(obs).slice(0, 1500)).toBe('running');
    const step = Number(obs['stepIndex']);
    await expect.poll(async () => Number((await tool('tl_game_observe', { playSessionId }))['stepIndex']), { timeout: 10_000 }).toBeGreaterThan(step + 30);
    expect(await scriptErrors()).toHaveLength(1);
    // Only the asked parts: the errors and logs alone; the observation's header and the player. Every part of a whole
    // observation is a section name; an unknown name is refused with the valid ones.
    const only = (await tool('tl_diagnostics', { playSessionId, sections: ['runtime'] })) as { diagnostics?: { runtime?: { errors?: unknown[] } } };
    expect(Object.keys(only.diagnostics ?? {})).toEqual(['runtime']);
    expect(only.diagnostics!.runtime!.errors!.length).toBeGreaterThan(0);
    const part = await tool('tl_game_observe', { playSessionId, sections: ['player', 'scenes'] });
    expect(Object.keys(part).filter((k) => !(GAME_OBSERVATION_HEADER as readonly string[]).includes(k)).sort()).toEqual(['player', 'scenes']);
    expect(part['state']).toBe('running');
    expect(Object.keys(obs).filter((k) => !([...GAME_OBSERVATION_HEADER, ...GAME_OBSERVATION_SECTIONS] as string[]).includes(k))).toEqual([]);
    const refused = (await mcp.callTool({ name: 'tl_game_observe', arguments: { playSessionId, sections: ['playre'] } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('unknown section \\"playre\\"');
    expect(refused.content[0]!.text).toContain('pausePanel');
    await expect.poll(async () => ((await tool('tl_diagnostics', {})) as { problems?: { code: string }[] }).problems?.map((p) => p.code) ?? [], { timeout: 10_000 }).toContainEqual(expect.stringMatching(/^script_error_behavior_playtest_probe_[0-9a-f]{16}$/));
    await tool('tl_play_stop', { playSessionId });
    const boom = await call({ frames: [walk(0, 90)], variables: { boom: 60 }, threads: 'worker', runs: 1 });
    expect(boom.isError, JSON.stringify(boom.body).slice(0, 1500)).toBe(false);
    expect(boom.body.runs[0]!.errors?.filter((e) => e['code'] !== 'behavior_log'), JSON.stringify(boom.body).slice(0, 1500)).toEqual([expect.objectContaining({ entityId: STARTER.playerId, message: expect.stringContaining('boom: the probe threw') })]);
  } finally {
    await mcp.close();
  }
});
