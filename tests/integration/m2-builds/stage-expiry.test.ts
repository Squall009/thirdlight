/**
 * Phase 14.9: an expired stage (past the 3600 s TTL — `resolveStage` refuses
 * it) no longer holds one of the eight open-stage slots. Found with the Sprout
 * level script: publications keep their stages, and eight stages from earlier
 * sessions refused every new upload (`stage_limits_exceeded`, open_stages)
 * until the 24 h abandoned-stage cleanup on the next open.
 */
import { existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeBuildEnv } from './helpers';

// workspace.md §7.6: eight open stages per project, a 3600 s stage TTL.
const MAX_OPEN_STAGES = 8;
const STAGE_TTL_SECONDS = 3600;
const bytes = new TextEncoder().encode('{"hello":"stage"}\n');
const id = (n: number): string => `stage-${n.toString(16).padStart(4, '0')}`;

describe('stage expiry and the open-stage limit', () => {
  it('fresh stages fill the limit; expired ones are removed when a new one is staged', () => {
    const env = makeBuildEnv('stage-expiry');
    const staging = join(env.root, 'projects', env.project, '.thirdlight', 'staging');
    for (let n = 1; n <= MAX_OPEN_STAGES; n++) expect(env.svc.stageContent(env.project, { stageId: id(n), bytes }).ok).toBe(true);
    // Eight fresh stages: a ninth is refused, as before.
    const refused = env.svc.stageContent(env.project, { stageId: id(99), bytes });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('stage_limits_exceeded');
    // Three of them expire (their directories are older than the TTL).
    const old = (Date.now() - (STAGE_TTL_SECONDS + 60) * 1000) / 1000;
    for (const n of [1, 2, 3]) utimesSync(join(staging, id(n)), old, old);
    const staged = env.svc.stageContent(env.project, { stageId: id(99), bytes });
    expect(staged.ok).toBe(true);
    for (const n of [1, 2, 3]) expect(existsSync(join(staging, id(n)))).toBe(false);
    for (const n of [4, 5, 6, 7, 8, 99]) expect(existsSync(join(staging, id(n)))).toBe(true);
  });
});
