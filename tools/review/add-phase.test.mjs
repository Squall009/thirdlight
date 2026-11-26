import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addPhase, dropPhaseFolder, KEPT_PHASES, packPictures, parseAcceptance, parseArgs, parseRead, perfTable, readState } from './add-phase.mjs';

const dirs = [];
const temp = (name) => {
  const d = mkdtempSync(join(tmpdir(), `review-${name}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ACCEPTANCE = `# 9z — the phase

## What changed
- one
- two, with \`code\`

## What is wrong
- D900 a thing

## Numbers
- check 240 s

## Questions
1. **Keep it?** **Default: yes.**
2. Drop the other one? Default: no, keep it.
   Answer: dropped.

## The full text
More words the page only links.
`;

const READ = `# Read of picture set x

Summary:

1. two pictures
2. one wrong

## L1 — Street at noon

File: L01.png (settled).

Sees: a street,
  two houses.
Wrong: specks on the gable (D828).
Sure: high

## L2 — Room

Sees: a room.
Wrong: nothing seen.
Sure: medium: dark

## L3 — Cave

Sees: TO WRITE
Wrong: TO WRITE
Sure: TO WRITE
`;

function makePack(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['L01.png', 'L02.png', 'L03.png']) writeFileSync(join(dir, f), 'png');
  writeFileSync(join(dir, 'read.md'), READ);
  writeFileSync(join(dir, 'perf-report.md'), '# Perf\n\n| | this run | previous |\n|---|---|---|\n| frame rate | 30 fps | — |\n');
  writeFileSync(join(dir, 'pictures.json'), JSON.stringify({ seconds: 868, commit: 'abc', pictures: [
    { id: 'L1', title: 'Street at noon', file: 'L01.png', settled: true },
    { id: 'L2', title: 'Room', file: 'L02.png', settled: true },
    { id: 'L3', title: 'Cave', file: 'L03.png', settled: false },
  ] }));
  mkdirSync(join(dir, 'raw'));
  writeFileSync(join(dir, 'raw', 'big.bin'), 'x');
  return dir;
}

describe('the acceptance text', () => {
  it('reads the four fixed sections and the questions with their defaults and answers', () => {
    const a = parseAcceptance(ACCEPTANCE);
    expect(a.title).toBe('9z — the phase');
    expect(a.changed).toEqual(['one', 'two, with `code`']);
    expect(a.wrong).toEqual(['D900 a thing']);
    expect(a.numbers).toEqual(['check 240 s']);
    expect(a.questions).toEqual([
      { n: 1, ask: 'Keep it?', default: 'yes.', answer: null },
      { n: 2, ask: 'Drop the other one?', default: 'no, keep it.', answer: 'dropped.' },
    ]);
    expect(a.errors).toEqual([]);
  });

  it('gives null for a missing section and refuses a broken form', () => {
    const a = parseAcceptance('# t\n\n## Questions\n1. a? Default: x\n2. b?\n');
    expect(a.changed).toBeNull();
    expect(a.wrong).toBeNull();
    expect(a.errors).toEqual(['question 2 has no "Default:"']);
    const six = parseAcceptance(`## What changed\n${'- x\n'.repeat(6)}\n## Questions\n${[1, 2, 3, 4, 5, 6].map((n) => `${n}. q Default: y`).join('\n')}\n`);
    expect(six.errors).toEqual(['"What changed" has 6 lines; at most 5', '6 questions; at most 5']);
  });
});

describe('the read', () => {
  it('parses the summary and each picture into Sees, Wrong and Sure, an unfilled field as not provided', () => {
    const r = parseRead(READ);
    expect(r.summary).toEqual(['two pictures', 'one wrong']);
    expect(r.pictures.get('L1')).toEqual({ id: 'L1', title: 'Street at noon', sees: 'a street, two houses.', wrong: 'specks on the gable (D828).', sure: 'high' });
    expect(r.pictures.get('L2').wrong).toBe('nothing seen.');
    expect(r.pictures.get('L3')).toMatchObject({ sees: null, wrong: null, sure: null });
  });

  it('orders the wrong and the unsettled pictures first, and lists a pack without pictures.json by file name', () => {
    const pack = makePack(join(temp('pack'), 'p'));
    expect(packPictures(pack).map((p) => [p.id, p.wrong])).toEqual([['L1', true], ['L3', true], ['L2', false]]);
    const bare = temp('bare');
    writeFileSync(join(bare, 'b.png'), '');
    writeFileSync(join(bare, 'a.jpg'), '');
    writeFileSync(join(bare, 'notes.txt'), '');
    expect(packPictures(bare).map((p) => [p.file, p.read])).toEqual([['a.jpg', null], ['b.png', null]]);
  });

  it('takes the perf report table without its separator row', () => {
    expect(perfTable('x\n| | a | b |\n|---|:-:|---|\n| fps | 30 | — |\n')).toEqual([['', 'a', 'b'], ['fps', '30', '—']]);
  });
});

describe('the page and the two-section rule', () => {
  it('keeps the phase being worked on and the one before, deleting the dropped phase folder under the root', () => {
    const root = temp('root');
    const src = temp('src');
    const pack = makePack(join(src, 'pack'));
    writeFileSync(join(src, 'acc.md'), ACCEPTANCE);
    addPhase({ root, id: 'p1', title: 'Phase 1', pictures: pack });
    addPhase({ root, id: 'p2', title: 'Phase 2', acceptance: join(src, 'acc.md') });
    expect(existsSync(join(root, 'p1', 'pictures', 'L01.png'))).toBe(true);
    expect(existsSync(join(root, 'p1', 'pictures', 'raw'))).toBe(false);
    const r = addPhase({ root, id: 'p3', title: 'Phase 3', pictures: pack });
    expect(KEPT_PHASES).toBe(2);
    expect(r.phases).toEqual(['p2', 'p3']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].id).toBe('p1');
    expect(r.dropped[0].bytes).toBeGreaterThan(0);
    expect(existsSync(join(root, 'p1'))).toBe(false);
    expect(existsSync(pack)).toBe(true);
    expect(readState(root).phases.map((p) => p.id)).toEqual(['p2', 'p3']);
    // Updating a kept phase adds its part and drops nothing.
    expect(addPhase({ root, id: 'p3', acceptance: join(src, 'acc.md') }).dropped).toEqual([]);

    const html = readFileSync(join(root, 'review.html'), 'utf8');
    expect(html.match(/<section /g)).toHaveLength(2);
    expect(html.indexOf('id="p3"')).toBeLessThan(html.indexOf('id="p2"'));
    for (const h of ['What changed', 'Pictures', 'What is wrong', 'Numbers', 'Questions']) expect(html).toContain(`<h3>${h}</h3>`);
    expect(html).toContain('src="p3/pictures/L01.png"');
    expect(html).toContain('specks on the gable (D828).');
    expect(html).toContain('<b>Default:</b> yes.');
    expect(html).toContain('Picture run: 868 s at abc.');
    expect(html).toContain('<td>30 fps</td>');
    expect(html).not.toMatch(/https?:\/\//);
    // p2 has no pictures: said, not invented.
    const p2 = html.slice(html.indexOf('id="p2"'));
    expect(p2).toMatch(/<h3>Pictures<\/h3><p class="none">not provided<\/p>/);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(html);
  });

  it('never deletes outside the root: a link is removed as a link, a path id refused', () => {
    const root = temp('root');
    const outside = temp('outside');
    writeFileSync(join(outside, 'keep.png'), 'owner data');
    symlinkSync(outside, join(root, 'linked'));
    expect(dropPhaseFolder(root, 'linked')).toBeLessThan(1000);
    expect(existsSync(join(root, 'linked'))).toBe(false);
    expect(existsSync(join(outside, 'keep.png'))).toBe(true);
    for (const bad of ['..', '../x', '/etc', 'a/b', '', '.hidden']) expect(() => dropPhaseFolder(root, bad)).toThrow(/not a phase id/);
    expect(dropPhaseFolder(root, 'absent')).toBe(0);
    expect(() => addPhase({ root, id: '../up' })).toThrow(/phase id/);
  });

  it('refuses an acceptance text that breaks the form before changing anything', () => {
    const root = temp('root');
    const bad = join(temp('src'), 'bad.md');
    writeFileSync(bad, '## Questions\n1. no default here\n');
    expect(() => addPhase({ root, id: 'p1', acceptance: bad })).toThrow(/no "Default:"/);
    expect(existsSync(join(root, 'phases.json'))).toBe(false);
  });

  it('reads its command line', () => {
    expect(parseArgs(['47t', '--title', 'T', '--pictures', 'x'])).toMatchObject({ id: '47t', title: 'T' });
    expect(() => parseArgs(['a', 'b'])).toThrow(/usage/);
    expect(() => parseArgs(['a', '--nope'])).toThrow(/unknown option/);
  });
});
