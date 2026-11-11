import { describe, expect, it } from 'vitest';

import { PlayLink, type PlayStartResult } from './play-link';

const start = (id: string): PlayStartResult => ({ playSessionId: id, playBase: 'http://127.0.0.1:1', snapshotId: 's', revision: 1, expiresAt: 0 });

describe('the editor\'s play link', () => {
  it('ends the running play on its own stop, never on a late stop of the play before it', () => {
    const stops: string[] = [];
    const link = new PlayLink({ projectId: 'p', previewOrigin: '', get: async () => ({}) as never, send: () => true, started: () => undefined, stopped: (r) => void stops.push(r), snapshotFailed: () => undefined });
    // This tab stopped play A (its page gone, so the backend confirms the stop late) and started play B.
    link.begin(start('play-a'));
    link.end('play-a');
    link.begin(start('play-b'));
    expect(link.receiveStopped('play-a', 'request')).toBe(false);
    expect(stops).toEqual([]);
    expect(link.current?.playSessionId).toBe('play-b');
    // B's own stop ends it; a stop without an id (an older backend frame) still ends what runs.
    expect(link.receiveStopped('play-b', 'preview_timeout')).toBe(true);
    expect(stops).toEqual(['preview_timeout']);
    expect(link.current).toBeNull();
    link.begin(start('play-c'));
    expect(link.receiveStopped('', 'request')).toBe(true);
    expect(stops).toEqual(['preview_timeout', 'request']);
  });
});
