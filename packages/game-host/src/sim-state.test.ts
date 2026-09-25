/**
 * Phase 21.5: the page-side mirror of the simulation worker keeps its queued
 * sound and effect requests bounded like the runtime's own queues, so a page
 * that does not take them (scene mode, headless) never grows.
 */
import { describe, expect, it } from 'vitest';

import { FrameMirror, MIRROR_AUDIO_LIMIT, MIRROR_EFFECT_LIMIT } from './sim-state';

const frame = (seq: number, audio: number, effects: number) => ({
  seq,
  stepIndex: seq,
  simTime: seq / 120,
  alpha: 0,
  frameCount: seq,
  state: 'running' as never,
  paused: false,
  debugHeld: false,
  audio: Array.from({ length: audio }, (_, i) => ({ assetId: `a${seq}-${i}`, volume: 1, stepIndex: seq })),
  effects: Array.from({ length: effects }, (_, i) => ({ id: `e${seq}-${i}` })),
});

describe('FrameMirror request queues', () => {
  it('stay bounded when nobody takes them (sounds: the first 16; effects: the newest 256)', () => {
    const m = new FrameMirror();
    for (let seq = 1; seq <= 100; seq += 1) m.apply(frame(seq, 5, 10) as never);
    expect(m.audio).toHaveLength(MIRROR_AUDIO_LIMIT);
    expect(m.audio[0]!.assetId).toBe('a1-0');
    expect(m.effects).toHaveLength(MIRROR_EFFECT_LIMIT);
    expect((m.effects[MIRROR_EFFECT_LIMIT - 1] as { id: string }).id).toBe('e100-9');
  });

  it('pass every request through when the page takes them each frame', () => {
    const m = new FrameMirror();
    let sounds = 0;
    let effects = 0;
    for (let seq = 1; seq <= 50; seq += 1) {
      m.apply(frame(seq, 3, 7) as never);
      sounds += m.audio.splice(0).length;
      effects += m.effects.splice(0).length;
    }
    expect(sounds).toBe(150);
    expect(effects).toBe(350);
  });
});
