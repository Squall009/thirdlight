/**
 * Media drop checks — the pure session layer. Pure Node (no DOM, no clock,
 * no Node built-ins — the boundary row's `node: []` holds for tests too).
 */
import { describe, expect, it } from 'vitest';
import { validateMediaDrop } from './media';
import { CONTENT_STAGE_MAX } from '@thirdlight/protocol';

const STAGE_MAX = CONTENT_STAGE_MAX;

// ---------------------------------------------------------------------------
// validateMediaDrop
// ---------------------------------------------------------------------------

describe('validateMediaDrop — the extension decides the kind before any network call', () => {
  it('accepts a .glb as a model with a trimmed display name', () => {
    const r = validateMediaDrop('Hero.glb', 1024);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('model');
      expect(r.displayName).toBe('Hero');
    }
  });

  it('accepts a .wav as audio (case-insensitive extension)', () => {
    const r = validateMediaDrop('Cue.WAV', 44);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('audio');
      expect(r.displayName).toBe('Cue');
    }
  });

  it('accepts .ttf/.otf/.woff2/.woff as a font', () => {
    for (const name of ['Title.ttf', 'Title.OTF', 'Title.woff2', 'Title.woff']) {
      const r = validateMediaDrop(name, 1000);
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.kind).toBe('font');
        expect(r.displayName).toBe('Title');
      }
    }
  });

  it('refuses any other extension with an actionable message', () => {
    for (const name of ['hero.txt', 'hero.mp4', 'hero', 'wav.glb.txt']) {
      const r = validateMediaDrop(name, 10);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('import_rejected');
    }
  });

  it('refuses an empty file', () => {
    const r = validateMediaDrop('empty.glb', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('import_rejected');
  });

  it('enforces the 32 MiB stage bound (exactly at the bound is allowed)', () => {
    expect(validateMediaDrop('ok.glb', STAGE_MAX).ok).toBe(true);
    const over = validateMediaDrop('over.wav', STAGE_MAX + 1);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('stage_limits_exceeded');
  });

  it('truncates a very long display name', () => {
    const r = validateMediaDrop('a'.repeat(400) + '.glb', 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.displayName.length).toBeLessThanOrEqual(128);
  });
});
