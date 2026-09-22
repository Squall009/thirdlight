/**
 * Shared helpers for `tests/integration/m2-builds/**` (packet 33).
 *
 * Real temporary data roots on ext4 (`/home/dadmin/.tl07-tmp-*`), the real
 * workspace service, the real commands pipeline and the real injected
 * `behavior-build` compiler. Nothing is mocked where the contract requires real
 * behavior.
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBehaviorCompiler, type BehaviorCompiler } from '@thirdlight/behavior-build';
import { openWorkspaceService, type WorkspaceService } from '@thirdlight/workspace';

export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const MIGRATION_SOURCE = join(REPO_ROOT, 'fixtures', 'm2', 'contracts', 'migration', 'v1-source');
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
 * A disposable M2 project: the accepted M1 migration source is copied and
 * migrated into a fresh `storageVersion 2` project with an empty content block,
 * then the real compiler is injected into the workspace service.
 */
export function makeBuildEnv(tag = 'm2build'): BuildEnv {
  const root = makeRoot(tag);
  const project = 'demo-build-01';
  seedProject(root, MIGRATION_SOURCE, 'demo-m1');
  const compiler = createBehaviorCompiler({ now: () => Date.now() });
  const svc = openWorkspaceService({ root, behaviorCompiler: compiler });
  const migrated = svc.migrateProjectCopy('demo-m1', project);
  if (!migrated.ok) throw new Error(`migration failed: ${JSON.stringify(migrated)}`);
  return { root, project, svc, compiler };
}

export function requestId(n: number): string {
  return `req-${n.toString(16).padStart(32, '0')}`;
}

export const ORIGIN = { kind: 'mcp' as const, clientId: 'pi-harness' };

/** Read the on-disk authoring envelope bytes (the durable state). */
export function envelopeBytes(env: BuildEnv): Uint8Array {
  return new Uint8Array(readFileSync(join(env.root, 'projects', env.project, 'scenes', 'main.json')));
}

export function envelopeJson(env: BuildEnv): {
  scene: { revision: number };
  content: { behaviors: { behaviorId: string; source: unknown }[]; behaviorTrust: { entries: { sourceDigest: string }[] } };
} {
  return JSON.parse(new TextDecoder().decode(envelopeBytes(env)));
}
