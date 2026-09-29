#!/usr/bin/env node
/**
 * The headless play-test runner, from the command line — the
 * same runner as the MCP tool `tl_playtest` (dist/mcp-adapter/playtest.mjs,
 * built by `npm run build`), against the RUNNING backend. With no editor open
 * the backend plays in its headless editor.
 *
 *   node tools/playtest.mjs <folder> (--input FILE | --driver FILE) [options]
 *
 *   <folder>            a game folder holding thirdlight.json (registered with the backend),
 *                       or --project <id> for a project in the backend's data root
 *   --input FILE        an input script: JSON, a list of tl_input_exercise frames
 *                       ({stepOffset (from the run's first step), steps?, actions?, pointer?, gamepad?, ui?})
 *                       or {frames: [...]}
 *   --driver FILE       the project's driver module (.mjs/.js; relative to the folder): its default export
 *                       async (game) => result plays each run (game.step(frames), game.wait(n),
 *                       game.observe(), game.log(text)); its result is the run's result
 *   --scene ID          start at this scene
 *   --mode ID           start in this game mode
 *   --variables FILE    script variables (JSON object): ctx.save at the start and at every restart
 *   --observe FILE      the observation spec (JSON {fields?, atSteps?, entityId?})
 *   --fields a,b.c      the observed fields (dot paths into the tl_game_observe document)
 *   --at 60,120         also observe right after these run steps (input scripts)
 *   --threads MODE      project (default) | worker | single | both
 *   --runs N            runs per threading mode (default 2)
 *   --timeout-ms N      the whole test's bound (default 600000)
 *   --out FILE          also write the JSON result there
 *   --origin URL        (default $THIRDLIGHT_ORIGIN or http://127.0.0.1:8501)
 *   --token-file PATH   (default ~/thirdlight/owner-token)
 *
 * Prints the JSON result on stdout. Exit status: 0 when every run finished and
 * the runs agree (the same run digest at every observed step), 1 when a run
 * failed or the runs disagree, 2 for a usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(ENGINE_ROOT, 'dist', 'mcp-adapter', 'playtest.mjs');

class UsageError extends Error {}

function parse(argv) {
  const o = { positional: [], origin: process.env.THIRDLIGHT_ORIGIN ?? 'http://127.0.0.1:8501', tokenFile: join(homedir(), 'thirdlight', 'owner-token') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new UsageError(`${a} needs a value`);
      i += 1;
      return argv[i];
    };
    if (a === '--input') o.input = next();
    else if (a === '--driver') o.driver = next();
    else if (a === '--project') o.project = next();
    else if (a === '--scene') o.scene = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--variables') o.variables = next();
    else if (a === '--observe') o.observe = next();
    else if (a === '--fields') o.fields = next();
    else if (a === '--at') o.at = next();
    else if (a === '--threads') o.threads = next();
    else if (a === '--runs') o.runs = next();
    else if (a === '--timeout-ms') o.timeoutMs = next();
    else if (a === '--out') o.out = next();
    else if (a === '--origin') o.origin = next().replace(/\/$/, '');
    else if (a === '--token-file') o.tokenFile = resolve(next());
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else o.positional.push(a);
  }
  return o;
}

function readJson(file, what) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${file}: ${e.message}`);
  }
}

const int = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`${what} must be an integer`);
  return n;
};

async function main() {
  const o = parse(process.argv.slice(2));
  if (!existsSync(RUNNER)) throw new UsageError(`${RUNNER} is missing: run npm run build first`);
  const { BackendClient, runPlaytest, playtestBackend } = await import(pathToFileURL(RUNNER).href);
  let token;
  try {
    token = readFileSync(o.tokenFile, 'utf8').trim();
  } catch {
    throw new UsageError(`cannot read the owner token at ${o.tokenFile} (use --token-file)`);
  }
  const client = new BackendClient({ authoringOrigin: o.origin, token, timeoutMs: 60_000 });

  // The project: the folder's registered project (or --project).
  const folderArg = o.positional[0];
  let folder = null;
  let projectId = o.project ?? null;
  if (folderArg !== undefined) {
    folder = isAbsolute(folderArg) ? folderArg : resolve(folderArg);
    let res;
    try {
      res = await client.resolveFolder(folder);
    } catch (e) {
      throw new Error(`the Thirdlight backend at ${o.origin} is not reachable (${e.message}); is it running?`);
    }
    if (res.body?.ok !== true) {
      const e = res.body?.error ?? {};
      if (e.reason === 'not_registered') throw new UsageError(`${folder} is not registered with the backend: node tools/project.mjs register ${folder}`);
      throw new UsageError(`${folder}: ${e.message ?? `not a Thirdlight project (status ${res.status})`}`);
    }
    if (projectId !== null && projectId !== res.body.projectId) throw new UsageError(`${folder} is project ${res.body.projectId}, not ${projectId}`);
    projectId = res.body.projectId;
    folder = res.body.folder ?? folder;
  }
  if (projectId === null) throw new UsageError('give a game folder (or --project <id>)');

  const spec = {};
  if (o.input !== undefined) {
    const script = readJson(o.input, 'the input script');
    spec.frames = Array.isArray(script) ? script : script?.frames;
    if (!Array.isArray(spec.frames)) throw new UsageError(`${o.input}: an input script is a list of frames or {frames: [...]}`);
  }
  if (o.driver !== undefined) {
    const file = isAbsolute(o.driver) ? o.driver : resolve(folder ?? process.cwd(), o.driver);
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') throw new UsageError(`${file} has no default export function (async (game) => result)`);
    spec.driver = mod.default;
    spec.driverName = o.driver;
  }
  if (o.scene !== undefined) spec.sceneId = o.scene;
  if (o.mode !== undefined) spec.mode = o.mode;
  if (o.variables !== undefined) spec.variables = readJson(o.variables, 'the variables');
  const observe = o.observe !== undefined ? readJson(o.observe, 'the observation spec') : {};
  if (o.fields !== undefined) observe.fields = o.fields.split(',').filter((f) => f.length > 0);
  if (o.at !== undefined) observe.atSteps = o.at.split(',').map((s) => int(s, '--at'));
  if (Object.keys(observe).length > 0) spec.observe = observe;
  if (o.threads !== undefined) spec.threads = o.threads;
  if (o.runs !== undefined) spec.runs = int(o.runs, '--runs');
  if (o.timeoutMs !== undefined) spec.timeoutMs = int(o.timeoutMs, '--timeout-ms');

  const result = await runPlaytest(playtestBackend(client, projectId), projectId, spec);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (o.out !== undefined) writeFileSync(o.out, text);
  process.stdout.write(text);
  if (result.ok === false && result.error.code === 'playtest_invalid') process.exit(2);
  process.exit(result.ok === true && result.deterministic ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`playtest: ${e.message}\n`);
  if (e instanceof UsageError) {
    process.stderr.write('usage: node tools/playtest.mjs <folder> (--input FILE | --driver FILE) [--scene ID] [--mode ID] [--variables FILE] [--observe FILE] [--fields a,b] [--at N,M] [--threads project|worker|single|both] [--runs N] [--timeout-ms N] [--out FILE] [--origin URL] [--token-file PATH]\n');
    process.exit(2);
  }
  process.exit(1);
});
