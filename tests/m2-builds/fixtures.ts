/**
 * Shared fixture access for the behavior-build tests (packet 33,
 * `fixtures/m2/behaviors/expected.json`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DeclaredProperty } from '@thirdlight/project-model';

import type { BehaviorCompilerLimits, PinnedModuleRef } from '../../packages/behavior-build/src/index';

export const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
export const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures', 'm2', 'behaviors');

export interface FixtureCase {
  caseId: string;
  container: string;
  containerDigest: string;
  containerByteLength: number;
  expect: Record<string, unknown>;
}

export interface FixtureIndex {
  behaviorId: string;
  declaration: { properties: Record<string, unknown>[] };
  limits: BehaviorCompilerLimits;
  pinnedModules: PinnedModuleRef[];
  cases: FixtureCase[];
  validSample: {
    container: string;
    outputArtifact: { path: string; digest: string; byteLength: number };
    manifest: Record<string, unknown>;
    manifestDigest: string;
    recipe: Record<string, unknown>;
    recipeDigest: string;
  };
  declarationCases: { caseId: string; declaration: string; expect: Record<string, unknown> }[];
  injectedCases: { caseId: string; injection: string; expect: Record<string, unknown> }[];
}

export const index: FixtureIndex = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, 'expected.json'), 'utf8'),
) as FixtureIndex;

export function containerBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_ROOT, rel)));
}

export function containerText(rel: string): string {
  return readFileSync(join(FIXTURE_ROOT, rel), 'utf8');
}

/** The declaration as the fixture index records it (structurally typed loosely). */
export function fixtureDeclaration(): { properties: DeclaredProperty[] } {
  return index.declaration as unknown as { properties: DeclaredProperty[] };
}

/** Compare only the keys the fixture pins (the p18 fixture convention). */
export function expectMatches(expect: Record<string, unknown>, derived: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [k, v] of Object.entries(expect)) {
    const got = derived[k];
    if (JSON.stringify(got) !== JSON.stringify(v)) {
      problems.push(`${k}: derived ${JSON.stringify(got)} != expected ${JSON.stringify(v)}`);
    }
  }
  return problems;
}
