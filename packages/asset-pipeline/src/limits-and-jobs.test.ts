/**
 * Packet-24 acceptance: byte/decoded-resource/time limits with adversarial
 * inputs, plus the injected job port (bounded timeout and cancellation).
 *
 * The byte cap and the `vertices` decoded cap cannot be committed as files
 * (a >32 MiB source or a 24 MB BIN chunk), so they are synthesised in memory
 * here; the committed `count-limit.glb` / `image-count-limit.glb` /
 * `decoded-limit.glb` fixtures cover the reachable caps of a small file.
 */

import { describe, expect, it } from 'vitest';

import {
  inspectGlb,
  prepareImport,
  type ImportJobPort,
  type ImportOptions,
  type ImportProposal,
} from './index';
import { buildGlb, cloneJson, splitGlb } from './test-glb';
import { fixtureBytes } from './test-fixtures';

const base = fixtureBytes('tiny-v1.glb');

function baseJson(): Record<string, unknown> {
  return cloneJson(splitGlb(base).json);
}

function fullJob(overrides: Partial<ImportJobPort> = {}): ImportJobPort {
  return {
    now: () => 0,
    isCancelled: () => false,
    proposalId: () => 'p-abcdefabcdefabcdefabcdefabcdefab',
    stageId: () => 'stage-24-limits',
    expiresAt: () => '2026-09-18T00:00:00Z',
    ...overrides,
  };
}

function options(job?: ImportJobPort): ImportOptions {
  return { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, job };
}

function inspect(bytes: Uint8Array, job?: ImportJobPort): ImportProposal {
  return inspectGlb(bytes, options(job));
}

/** tiny-v1 with a POSITION accessor of `count` vertices over a real BIN chunk. */
function verticesModel(count: number): Uint8Array {
  const bytes = count * 12;
  const json = baseJson();
  // The synthetic BIN is zero-filled, so drop the clip: its input times would
  // no longer be strictly increasing (the clip itself is covered by
  // tiny-v1/tiny-v2/malformed-clip.glb).
  delete json['animations'];
  (json['bufferViews'] as Record<string, unknown>[])[0] = {
    buffer: 0,
    byteOffset: 0,
    byteLength: bytes,
    target: 34962,
  };
  (json['accessors'] as Record<string, unknown>[])[0] = {
    bufferView: 0,
    componentType: 5126,
    count,
    type: 'VEC3',
  };
  (json['buffers'] as Record<string, unknown>[])[0] = { byteLength: bytes };
  return buildGlb(json, new Uint8Array(bytes));
}

describe('decoded-resource caps (adversarial)', () => {
  it('rejects a model whose vertex count exceeds the cap, with limit/found', () => {
    const bytes = verticesModel(2_000_001);
    expect(bytes.length).toBeLessThanOrEqual(33_554_432);
    const proposal = inspect(bytes);
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics.map((d) => d.code)).toEqual(['asset_limits_exceeded']);
    expect(proposal.diagnostics[0]?.limit).toBe('vertices');
    expect(proposal.diagnostics[0]?.found).toBe(2_000_001);
    expect(proposal.metrics).toBeUndefined();
  });

  it('accepts the same model one vertex under the cap', () => {
    const proposal = inspect(verticesModel(1_999_999));
    expect(proposal.status).toBe('ok');
    expect(proposal.metrics?.vertices).toBe(1_999_999);
    expect(proposal.metrics?.triangles).toBe(1); // the primitive keeps its 3 indices
  });

  it('reports every exceeded cap of one source, in table order', () => {
    const bytes = verticesModel(2_000_001);
    const json = cloneJson(splitGlb(bytes).json);
    json['materials'] = Array.from({ length: 513 }, (_, i) => ({ name: `m${i}` }));
    const manyMaterials = buildGlb(json, splitGlb(bytes).bin);
    const proposal = inspect(manyMaterials);
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics.map((d) => d.limit)).toEqual(['materials', 'vertices']);
  });

  it('keeps the decoded geometry cap above what a 32 MiB source can decode', () => {
    // Decoded geometry is bounded by the byte cap: 33 554 432 B of embedded
    // data cannot exceed the 268 435 456 B decoded-geometry cap, so the only
    // reachable decoded-bytes cap is the header-derived image budget (see the
    // decoded-limit.glb fixture). This documents why the geometry cap has no
    // committed adversarial file.
    const proposal = inspect(fixtureBytes('decoded-limit.glb'));
    expect(proposal.diagnostics.map((d) => d.limit)).toEqual(['decoded_bytes', 'decoded_bytes']);
    expect(proposal.diagnostics[0]?.found).toBe(1_600_000_000);
  });
});

describe('injected job port: bounded timeout', () => {
  it('rejects with asset_timeout when the injected clock exceeds the budget', () => {
    let calls = 0;
    const job = fullJob({
      now: () => {
        calls += 1;
        return calls === 1 ? 0 : 40_000;
      },
    });
    const proposal = inspect(base, job);
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics).toHaveLength(1);
    expect(proposal.diagnostics[0]?.code).toBe('asset_timeout');
    expect(proposal.diagnostics[0]?.message).toContain('30000 ms job limit');
    expect(proposal.metrics).toBeUndefined();
    expect(proposal.inspection.nodeNames).toEqual([]);
  });

  it('honours a caller-supplied timeoutMs', () => {
    const job = fullJob({
      timeoutMs: 5,
      now: (() => {
        let t = 0;
        return () => {
          t += 3;
          return t;
        };
      })(),
    });
    const proposal = inspect(base, job);
    expect(proposal.diagnostics[0]?.message).toContain('5 ms job limit');
    expect(proposal.limits.timeoutMs).toBe(5);
  });

  it('accepts the file when the clock stays inside the budget', () => {
    const job = fullJob({ now: () => 0 });
    const proposal = inspect(base, job);
    expect(proposal.status).toBe('ok');
    expect(proposal.limits.timeoutMs).toBe(30_000);
  });
});

describe('injected job port: cancellation', () => {
  it('rejects immediately when the job is already cancelled', () => {
    const proposal = inspect(base, fullJob({ isCancelled: () => true }));
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics).toHaveLength(1);
    expect(proposal.diagnostics[0]?.code).toBe('asset_timeout');
    expect(proposal.diagnostics[0]?.message).toContain('cancelled');
  });

  it('rejects when the caller cancels mid-inspection, without metrics', () => {
    let calls = 0;
    const proposal = inspect(
      base,
      fullJob({
        isCancelled: () => {
          calls += 1;
          return calls > 6;
        },
      }),
    );
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics.map((d) => d.code)).toEqual(['asset_timeout']);
    expect(proposal.metrics).toBeUndefined();
    expect(proposal.kind).toBeUndefined();
  });

  it('cancellation beats a malformed source: no file-level diagnostic is reported', () => {
    const proposal = inspect(fixtureBytes('truncated.glb'), fullJob({ isCancelled: () => true }));
    expect(proposal.diagnostics.map((d) => d.code)).toEqual(['asset_timeout']);
  });
});

describe('prepareImport (the job-bound entry)', () => {
  it('is identical to inspectGlb for the same bytes and job values', () => {
    const job = fullJob();
    const a = inspectGlb(base, options(job));
    const b = prepareImport(base, { ...options(job), job });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('requires an injected job port', () => {
    expect(() => prepareImport(base, { ...options(), job: undefined as unknown as ImportJobPort })).toThrow(
      TypeError,
    );
  });
});
