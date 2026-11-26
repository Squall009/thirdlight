/**
 * The profiler panel's poll across the real bridge: the fullest rings a play
 * page can hold are over the bridge's bound for a profile answer, the
 * preview's answer fits it all the same, and the panel's side gets a report
 * with a cursor (without one it asks for everything again at every poll).
 */
import { describe, expect, it } from 'vitest';
import { BRIDGE_PROFILE_RESULT_MAX_BYTES } from '@thirdlight/protocol';
import { PROFILE_FRAMES, PROFILE_SPANS_PER_FRAME } from '@thirdlight/shared';
import type { ProfileReport } from '@thirdlight/game-host/profile-view';

import { BRIDGE_REFUSED_CODE, Bridge } from './bridge';
import { profileAnswer } from './profile-answer';

const EDITOR_ORIGIN = 'http://127.0.0.1:8501';
const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';
const PLAY_ID = 'play-' + 'b'.repeat(32);
const RELAY = 'relay-' + '2'.repeat(32);
const BUILD = 'd'.repeat(64);

type Frame = ProfileReport['threads']['page'][number];

/** A frame as a busy world's thread records it: every span slot used. */
function frame(thread: Frame['thread'], n: number, start: number): Frame {
  const spans = Array.from({ length: PROFILE_SPANS_PER_FRAME }, (_, i) => ({ name: `voxel streaming step ${i % 40}`, category: 'voxelStream' as const, start: start + i * 0.0123, ms: 0.0456 + i * 0.001, selfMs: 0.0234, depth: i % 4, ...(thread === 'jobs' ? { lane: i % 6 } : {}) }));
  return { thread, frame: n, ...(thread !== 'jobs' ? { tick: n } : {}), start, ms: 7.1234, byCategory: { voxelStream: 5.4321, render: 1.2345 }, spans, dropped: 3 };
}

/** The whole of what a page keeps on a busy world, as a first read gives it: full rings on every thread and eight kept long frames. */
function fullRings(): ProfileReport {
  const t0 = 1_764_170_000_000;
  const ring = (thread: Frame['thread']): Frame[] => Array.from({ length: PROFILE_FRAMES }, (_, i) => frame(thread, 1000 + i, t0 + i * 33.3 + (thread === 'sim' ? 5 : 0)));
  const spikes = Array.from({ length: 8 }, (_, k) => {
    const from = t0 - 60_000 + k * 5000;
    const of = (thread: Frame['thread']): Frame[] => Array.from({ length: 8 }, (_, i) => frame(thread, 100 * k + i, from + i * 33.3));
    return { at: from + 300, reason: 'interval' as const, ms: 140 + k, thresholdMs: 50, from, to: from + 270, threads: { page: of('page'), sim: of('sim'), jobs: of('jobs') } };
  });
  return {
    at: t0 + 4000,
    quality: 'low',
    frameRateCap: 30,
    intervalMs: 33.3,
    threads: { page: ring('page'), sim: ring('sim'), jobs: ring('jobs') },
    counters: { frames: Array.from({ length: PROFILE_FRAMES }, (_, i) => ({ frame: 1000 + i, drawCalls: 180, triangles: 420_000, heapBytes: 91_000_000 })), stats: null, instances: null, gpuResources: null, voxels: null, queues: null },
    gpu: { timestamps: false, shares: null, room: 'not measurable here' },
    budget: { tier: 'low', hz: 30, intervalMs: 33.3, rows: [], gpu: {} },
    slices: [],
    spikes,
    cost: { pageSpansPerFrame: PROFILE_SPANS_PER_FRAME, nsPerSpan: 900 },
    seq: { page: 1000 + PROFILE_FRAMES, sim: 1000 + PROFILE_FRAMES, spikes: 8 },
  } as unknown as ProfileReport;
}

/** The two ends of a play's bridge, and what the editor's end hears as profile answers. */
function pair(): { preview: Bridge; got: Array<Record<string, unknown>> } {
  const previewWin = { tag: 'preview-window' };
  const editor = new Bridge({ direction: 'editor', expectedOrigin: PREVIEW_ORIGIN, targetOrigin: PREVIEW_ORIGIN, post: () => undefined, isTrustedSource: (s) => s === previewWin, makeNonce: () => 'a'.repeat(16) });
  const preview = new Bridge({ direction: 'preview', expectedOrigin: EDITOR_ORIGIN, targetOrigin: EDITOR_ORIGIN, post: (data) => editor.handleMessage({ origin: PREVIEW_ORIGIN, source: previewWin, data }), isTrustedSource: () => true });
  const got: Array<Record<string, unknown>> = [];
  editor.on('tl.profile.result', (m) => got.push(m as Record<string, unknown>));
  return { preview, got };
}

describe('the preview\'s answer to the profiler\'s poll', () => {
  it('fits the bridge\'s bound when the page\'s rings are full: the panel gets the newest frames and a cursor, where the read as it is was refused', () => {
    const report = fullRings();
    expect(JSON.stringify(report).length, 'the page keeps more than an answer may hold').toBeGreaterThan(BRIDGE_PROFILE_RESULT_MAX_BYTES);
    // The read as it is: the bridge refuses it, and the panel hears an error with no report and no cursor.
    const raw = pair();
    raw.preview.sendProfileResult(PLAY_ID, RELAY, { ok: true, result: { report, build: BUILD, renderer: 'webgpu' } });
    expect(raw.got).toEqual([expect.objectContaining({ ok: false, relayId: RELAY, error: expect.objectContaining({ code: BRIDGE_REFUSED_CODE }) })]);
    // The preview's answer: delivered.
    const fit = pair();
    fit.preview.sendProfileResult(PLAY_ID, RELAY, { ok: true, result: profileAnswer(report, BUILD, 'webgpu') });
    expect(fit.preview.drops.total).toBe(0);
    expect(fit.got).toHaveLength(1);
    expect(fit.got[0]).toMatchObject({ ok: true, relayId: RELAY });
    const result = fit.got[0]!['result'] as { report: ProfileReport; build: string; renderer: string };
    expect([result.build, result.renderer]).toEqual([BUILD, 'webgpu']);
    expect(result.report.seq).toEqual({ page: report.seq.page, sim: report.seq.sim, spikes: expect.any(Number) });
    // The newest frames of the page's ring, to its last.
    const pageFrames = result.report.threads.page.map((f) => f.frame);
    expect(pageFrames.length).toBeGreaterThan(10);
    expect(pageFrames.at(-1)).toBe(1000 + PROFILE_FRAMES - 1);
    // Spikes not sent yet are asked for by the cursor the answer carries.
    expect(result.report.spikes.length).toBeGreaterThan(0);
    expect(result.report.seq.spikes).toBe(result.report.spikes.length);
  });

  it('leaves a read that fits as it is', () => {
    const report = { ...fullRings(), threads: { page: [], sim: [], jobs: [] }, spikes: [] } as unknown as ProfileReport;
    expect(profileAnswer(report, BUILD, null).report).toBe(report);
  });
});
