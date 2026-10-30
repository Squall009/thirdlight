/**
 * Every private three.js hook the engine installs is in the upgrade
 * checklist: a three upgrade reads that list, so a hook missing from it is
 * one nobody checks until it fails silently (the hooks are guarded and
 * their unit tests run against fakes of three's behaviour).
 */
import { describe, expect, it } from 'vitest';

import { checklistRows, covers, hookSites, uncovered } from './three-hooks.mjs';

describe('three upgrade checklist', () => {
  it('finds the hooks by shape', () => {
    const sites = hookSites();
    const has = (file, member) => sites.some((s) => s.file.endsWith(file) && s.member === member);
    // One of each kind the scan looks for, so a scan that finds nothing does not pass.
    expect(has('observer-refresh.ts', 'setupObserver')).toBe(true);
    expect(has('local-lights.ts', 'renderObject')).toBe(true);
    expect(has('post-ao.ts', 'library.addLight')).toBe(true);
    expect(has('post-upscale.ts', 'updateBefore')).toBe(true);
    expect(has('dispose.ts', '_releasePipeline')).toBe(true);
    expect(has('block-ao-lighting.ts', 'builder.geometry')).toBe(true);
    expect(has('mesh-decals.ts', 'builder.camera')).toBe(true);
    expect(sites.some((s) => s.member.startsWith('_tl'))).toBe(false);
  });

  it('names every hook with its member in one row', () => {
    const missing = uncovered().map((s) => `${s.file}:${s.line} ${s.member}`);
    expect(missing, 'add these to docs/three-upgrade-checklist.md §1').toEqual([]);
  });

  it('needs the file and the member in the same row', () => {
    const site = { file: 'packages/three-adapter/src/post-upscale.ts', line: 1, member: 'setSize' };
    expect(covers('| `post-upscale.ts` | `setSize` |', site)).toBe(true);
    expect(checklistRows('| `post-upscale.ts` | x |\n| `other.ts` | `setSize` |').some((r) => covers(r, site))).toBe(false);
  });
});
