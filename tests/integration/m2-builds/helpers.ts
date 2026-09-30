/**
 * Shared helpers for `tests/integration/m2-builds/**`.
 *
 * Real temporary data roots on ext4 (`/home/dadmin/.tl07-tmp-*`), the real
 * workspace service, the real commands pipeline and the real injected
 * `behavior-build` compiler. Nothing is mocked where the contract requires real
 * behavior.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBehaviorCompiler, type BehaviorCompiler } from '@thirdlight/behavior-build';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const BUILD_FIXTURES = join(REPO_ROOT, 'fixtures', 'm2', 'behaviors');

const roots: string[] = [];
let backstopInstalled = false;

function backstop(): void {
  if (backstopInstalled) return;
  backstopInstalled = true;
  const cleanup = (): void => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  };
  // 'exit' covers normal exit and process.exit(); signal kills do NOT run
  // 'exit' handlers, so also clean up on the SIGTERM/SIGINT paths a
  // supervisor takes before escalating to SIGKILL. SIGKILL residue is
  // reaped by the next suite start (tests/test-hygiene.ts globalSetup).
  process.on('exit', cleanup);
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
}

export function makeRoot(tag: string): string {
  const base = join(
    tmpdir() === '/tmp' ? '/home/dadmin' : tmpdir(),
    `.tl07-tmp-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`,
  );
  mkdirSync(base, { recursive: true });
  roots.push(base);
  backstop();
  return base;
}

export function seedProject(root: string, diskDir: string, projectId: string): string {
  const dest = join(root, 'projects', projectId);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(diskDir, dest, { recursive: true });
  return dest;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(BUILD_FIXTURES, rel)));
}

export interface BuildFixtureIndex {
  behaviorId: string;
  declaration: unknown;
  pinnedModules: unknown;
  cases: { caseId: string; container: string; expect: Record<string, unknown> }[];
}

export function fixtureIndex(): BuildFixtureIndex {
  return JSON.parse(readFileSync(join(BUILD_FIXTURES, 'expected.json'), 'utf8')) as BuildFixtureIndex;
}

export interface BuildEnv {
  root: string;
  project: string;
  svc: WorkspaceService;
  compiler: BehaviorCompiler;
}

/**
 * A disposable project with an empty content block, created through the real
 * workspace service (storage v4: project.json, content.json,
 * scenes/scene-main.json), with the real compiler injected into the service.
 */
export function makeBuildEnv(tag = 'm2build'): BuildEnv {
  const root = makeRoot(tag);
  const project = 'demo-build-01';
  const compiler = createBehaviorCompiler({ now: () => Date.now() });
  const svc = openWorkspaceService({ root, behaviorCompiler: compiler });
  const created = svc.createProject(project, 'Build Demo');
  if (!created.ok) throw new Error(`createProject failed: ${JSON.stringify(created)}`);
  return { root, project, svc, compiler };
}

export function requestId(n: number): string {
  return `req-${n.toString(16).padStart(32, '0')}`;
}

export const ORIGIN = { kind: 'mcp' as const, clientId: 'pi-harness' };

/** The v4 authoritative files (store-v4.ts): the content file and the one scene file. */
const CONTENT_REL = 'content.json';
const SCENE_REL = join('scenes', 'scene-main.json');

/**
 * The on-disk authoring state bytes (the durable state): the v4 project's
 * content.json followed by its scene file, so "unchanged" means neither
 * authoritative file changed.
 */
export function envelopeBytes(env: BuildEnv): Uint8Array {
  const dir = join(env.root, 'projects', env.project);
  const resources = resourceFiles(dir).map((f) => readFileSync(join(dir, f)));
  return new Uint8Array(Buffer.concat([readFileSync(join(dir, CONTENT_REL)), readFileSync(join(dir, SCENE_REL)), ...resources]));
}

/** The project's resource files (a data-root project is its own game folder: `assets/<kind>/<id>.<kind>.json`), sorted. */
function resourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(dir, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${rel}/${name}`;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else if (/\.[a-z]+\.json$/.test(name)) out.push(path);
    }
  };
  walk('assets');
  return out.sort();
}

/**
 * The durable state in the single-envelope shape: `scene.revision` is the
 * project revision (the highest file revision, store-v4.ts) and `content` is
 * content.json's content block.
 */
export function envelopeJson(env: BuildEnv): {
  scene: { revision: number };
  content: { behaviors: { behaviorId: string; source: unknown }[]; behaviorTrust: { entries: { sourceDigest: string }[] } };
} {
  const dir = join(env.root, 'projects', env.project);
  const content = JSON.parse(readFileSync(join(dir, CONTENT_REL), 'utf8')) as {
    revision: number;
    content: { behaviors: { behaviorId: string; source: unknown }[]; behaviorTrust: { entries: { sourceDigest: string }[] } };
  };
  const scene = JSON.parse(readFileSync(join(dir, SCENE_REL), 'utf8')) as { scene: { revision: number } };
  // The resources are files of their own: each goes back into its content list.
  const lists: Record<string, string> = { behavior: 'behaviors', library: 'scriptLibraries', prefab: 'prefabs', material: 'materials' };
  const joined = { behaviors: [], ...content.content } as Record<string, unknown>;
  for (const f of resourceFiles(dir)) {
    const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { kind: string; data: unknown };
    const key = lists[r.kind];
    if (key === undefined) continue;
    joined[key] = [...((joined[key] as unknown[] | undefined) ?? []), r.data];
  }
  return { scene: { revision: Math.max(content.revision, scene.scene.revision) }, content: joined as typeof content.content };
}
