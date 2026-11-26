import { describe, expect, it } from 'vitest';

import { camerasOf, PICTURES, pictureListProblems, type PictureEntry, type WorldPicture } from './picture-list';
import { packFileName, packJson, packReadme, readSkeleton, worldResults, type PictureResult } from './picture-pack';

const META = { run: 'r1', commit: 'abc1234', startedAt: '2026-11-26T04:00:00.000Z', seconds: 300, host: {}, perf: 'perf-report.md' };

describe('the picture list', () => {
  it('has unique ids, a title and a line of what to look for on every entry, and only known cameras and screens', () => {
    expect(pictureListProblems(PICTURES)).toEqual([]);
    expect(PICTURES.length).toBeGreaterThanOrEqual(25);
    expect(PICTURES.length).toBeLessThanOrEqual(35);
  });

  it('names what is wrong with a bad list', () => {
    const bad: PictureEntry[] = [
      { kind: 'world', id: 'L1', camera: 'street-noon', run: 'day', title: 'A', look: 'house fronts in the sun and their shade' },
      { kind: 'world', id: 'L1', camera: 'street-noon', run: 'day', title: '', look: 'short' },
      { kind: 'world', id: 'x', camera: 'no-such' as never, run: 'night' as never, title: 'B', look: 'something long enough to read' },
      { kind: 'screen', id: 'E1', screen: 'no-screen' as never, title: 'C', look: 'something long enough to read' },
    ];
    const p = pictureListProblems(bad);
    expect(p).toContain('L1: the id is taken twice');
    expect(p).toContain('L1: no title');
    expect(p).toContain('L1: no line of what to look for');
    expect(p).toContain('L1: camera street-noon is in the list twice');
    expect(p).toContain('x: an id is a letter and a number');
    expect(p).toContain('x: no camera no-such');
    expect(p).toContain('x: no run night');
    expect(p).toContain('E1: no screen no-screen');
  });

  it('asks each light-shots run for its own cameras, in the list\'s order', () => {
    expect(camerasOf(PICTURES, 'lamps')).toEqual(['lamps-street', 'lamps-room', 'lamps-high']);
    expect(camerasOf(PICTURES, 'day')[0]).toBe('street-noon');
    expect(camerasOf(PICTURES, 'day')).not.toContain('lamps-room');
  });
});

describe('the picture pack', () => {
  const street = PICTURES.find((p) => p.id === 'L1') as WorldPicture;
  const room = PICTURES.find((p) => p.id === 'L2') as WorldPicture;
  const cave = PICTURES.find((p) => p.id === 'L3') as WorldPicture;
  const three = [street, room, cave];
  const shots = {
    world: 'far',
    quality: 'low',
    shots: [
      { name: 'street-noon', file: '/raw/street-noon.png', settledS: 3, texturesLoading: 0, store: 'volume', storeLitS: 13.2, blotch: { specks: { white: 12, green: 5, black: 5, clusters: 6 } }, counts: { chunks: 308 } },
      { name: 'room-window', file: '/raw/room-window.png', settledS: null, waiting: ['chunks 300–320'], store: 'volume', storeLitS: null, blotch: { specks: { white: 0, green: 0, black: 0, clusters: 0 } } },
    ],
  };

  it('reads a light-shots run: settled, not settled (with what it waited for), not taken', () => {
    const r = worldResults(three, 'day', shots, 'unused');
    expect(r.map((x) => x.id)).toEqual(['L1', 'L2', 'L3']);
    expect(r[0]).toMatchObject({ source: '/raw/street-noon.png', settled: true, specks: { white: 12, green: 5, black: 5, clusters: 6 } });
    expect(r[0]!.settle).toBe('streaming still after 3 s, no texture level loading, light volume settled after 13.2 s');
    expect(r[0]!.facts).toMatchObject({ camera: 'street-noon', world: 'far', quality: 'low', counts: { chunks: 308 } });
    expect(r[0]!.facts).not.toHaveProperty('benchError');
    expect(worldResults([street], 'day', { ...shots, error: 'Error: game relay failed' }, '')[0]).toMatchObject({ settled: true, facts: { benchError: 'Error: game relay failed' } });
    expect(r[1]).toMatchObject({ settled: false, settle: 'did not settle: streaming (chunks 300–320); the light volume' });
    expect(r[2]).toMatchObject({ source: null, settled: false, settle: 'not taken: the bench took no shot of this camera' });
    expect(worldResults(three, 'day', null, 'staging did not start')[0]!.settle).toBe('not taken: staging did not start');
    expect(worldResults(three, 'lamps', shots, '')).toEqual([]);
    const high = worldResults([street], 'day', { shots: [{ ...shots.shots[0]!, storeLitS: 1, storeState: { kept: 0 } }] }, '');
    expect(high[0]).toMatchObject({ settled: true, settle: 'streaming still after 3 s, no texture level loading, the light volume keeps no brick in its windows (nothing to light) after 1 s' });
  });

  it('names files so they sort as the list does, marking an unsettled one', () => {
    expect(packFileName(street)).toBe('L01-street-noon.png');
    expect(packFileName(room, true)).toBe('L02-room-window-UNSETTLED.png');
    expect(packFileName(PICTURES.find((p) => p.id === 'L14')!)).toBe('L14-town-100m.png');
    expect(packFileName(PICTURES.find((p) => p.id === 'E2')!)).toBe('E02-structure.png');
  });

  it('writes pictures.json in the list\'s order with every picture\'s state, and lists the failed ones', () => {
    const results: PictureResult[] = worldResults(three, 'day', shots, '');
    const json = packJson(three, results.slice(0, 2), META);
    const pics = json['pictures'] as Array<Record<string, unknown>>;
    expect(pics.map((p) => p['id'])).toEqual(['L1', 'L2', 'L3']);
    expect(pics[0]).toMatchObject({ title: street.title, look: street.look, file: 'L01-street-noon.png', settled: true });
    expect(pics[1]).toMatchObject({ file: 'L02-room-window-UNSETTLED.png', settled: false });
    expect(pics[2]).toMatchObject({ file: null, settled: false, settle: 'not taken: the command never reached it' });
    expect(json['failed']).toEqual(['L2', 'L3']);
    expect(json['taken']).toBe(2);
    expect(json).toMatchObject({ commit: 'abc1234', seconds: 300 });
  });

  it('writes the README and the read\'s skeleton: a block a picture in the fixed form', () => {
    const json = packJson(three, worldResults(three, 'day', shots, ''), META);
    const readme = packReadme(json);
    expect(readme).toContain('not taken or not settled: L2, L3');
    expect(readme).toContain(`**L1 — ${street.title}** (L01-street-noon.png)`);
    expect(readme).toContain('Specks (white/green/black, clusters): 12/5/5, 6.');
    const read = readSkeleton(json);
    expect(read.match(/^## /gm)).toHaveLength(3);
    for (const line of ['Sees: TO WRITE', 'Wrong: TO WRITE', 'Sure: TO WRITE']) expect(read.split('\n').filter((l) => l === line)).toHaveLength(3);
    expect(read).toContain('Summary (five lines');
    expect(read).toContain(`## L2 — ${room.title}`);
  });
});
