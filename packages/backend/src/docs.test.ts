/**
 * The documentation lookup over the checked-in manual: the contents, pages,
 * sections (from their anchor to the next heading of their level), reference
 * topics, link-form topics, searches, and the bound on every answer.
 */
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { DOCS_PART_CHARS, DOCS_QUERY_MAX, loadManual, pageSections, type Manual } from './docs';

const DOCS = resolve(import.meta.dirname, '..', '..', '..', 'docs');
let manual: Manual;

beforeAll(async () => {
  const m = await loadManual(['/nonexistent-docs-dir', DOCS]);
  if (m === null) throw new Error('no manual under docs/');
  manual = m;
});

const text = (a: ReturnType<Manual['lookup']>): string => {
  if (!a.ok || a.kind === 'query') throw new Error(`not a text answer: ${JSON.stringify(a).slice(0, 300)}`);
  return a.text;
};

describe('pageSections', () => {
  it('runs a section from its anchor to the next heading of its level or above; code is not a heading', () => {
    const page = '# T\n\nintro\n\n<a id="x"></a>\n## One\n\na\n\n### Sub\n\nb\n\n```\n## not a heading\n```\n\n## Two\n\nc\n';
    const { sections, ids } = pageSections(page);
    expect(sections.map((s) => s.title)).toEqual(['T', 'One', 'Sub', 'Two']);
    const one = sections[ids.get('x')!]!;
    expect(page.split('\n').slice(one.start, one.end).join('\n')).toBe('<a id="x"></a>\n## One\n\na\n\n### Sub\n\nb\n\n```\n## not a heading\n```\n');
    expect(ids.get('one')).toBe(ids.get('x'));
    expect(ids.get('two')).toBe(3);
  });
});

describe('the manual lookup', () => {
  it('answers the contents with the manual index and the reference topic kinds', () => {
    const a = manual.lookup({});
    expect(a.ok && a.kind === 'contents').toBe(true);
    const t = text(a);
    expect(t).toContain('# Thirdlight manual');
    expect(t).toContain('getting-started/first-project.md');
    expect(t).toMatch(/`op\.…` \(\d+\)/);
    expect(t).toMatch(/`tool\.…` \(\d+\)/);
  });

  it('answers a page, a section and a link written as in a page', () => {
    const page = text(manual.lookup({ topic: 'getting-started/first-project' }));
    expect(page.startsWith('# ')).toBe(true);
    const { sections } = pageSections(page);
    const second = sections.find((s) => s.level === 2)!;
    const sec = text(manual.lookup({ topic: `getting-started/first-project#${second.id}` }));
    expect(sec.startsWith(`## ${second.title}`)).toBe(true);
    expect(sec.length).toBeLessThan(page.length);
    expect(text(manual.lookup({ topic: `../getting-started/first-project.md#${second.id}` }))).toBe(sec);
    expect(text(manual.lookup({ topic: 'deployment' }))).toContain('MCP');
    // A same-folder link from a reference page, copied without its folder.
    expect(text(manual.lookup({ topic: 'types-a-d#type-block-edit' }))).toBe(text(manual.lookup({ topic: 'reference/types-a-d#type-block-edit' })));
    expect(text(manual.lookup({ topic: 'types-a-d.md#type-block-edit' }))).toContain('BlockEdit');
  });

  it('answers a reference topic with its section', () => {
    const op = text(manual.lookup({ topic: 'op.editBlocks' }));
    expect(op).toMatch(/^<a id="op-editBlocks"><\/a>\n## editBlocks/);
    expect(op).not.toContain('## editTerrain');
    expect(text(manual.lookup({ topic: 'component.light' }))).toContain('light');
    expect(text(manual.lookup({ topic: 'tool.tl_command.terrain' }))).toContain('editTerrain');
    // An anchor inside a table answers with the section holding it.
    expect(text(manual.lookup({ topic: 'limit.MAX_TAGS' }))).toContain('MAX_TAGS');
  });

  it('answers names an object inherits as unknown topics, not as a failure', () => {
    for (const topic of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'constructor#x']) {
      const a = manual.lookup({ topic });
      expect(a.ok, topic).toBe(false);
      if (!a.ok) expect(a.code, topic).toBe('docs_topic_not_found');
    }
  });

  it('bounds every answer and names the next part', () => {
    const first = manual.lookup({ topic: 'reference/graph-behavior-1' });
    if (!first.ok || first.kind === 'query') throw new Error('no page');
    expect(first.parts).toBeGreaterThan(1);
    expect(first.text.length).toBeLessThanOrEqual(DOCS_PART_CHARS);
    expect(first.next).toEqual({ topic: 'reference/graph-behavior-1', part: 2 });
    expect(first.sections?.length).toBeGreaterThan(0);
    const last = manual.lookup({ topic: 'reference/graph-behavior-1', part: first.parts });
    expect(last.ok && last.kind !== 'query' && last.next === undefined).toBe(true);
    let joined = '';
    for (let p = 1; p <= first.parts; p += 1) joined += (p > 1 ? '\n' : '') + text(manual.lookup({ topic: 'reference/graph-behavior-1', part: p }));
    expect(joined.length).toBeGreaterThan(DOCS_PART_CHARS);
    expect(manual.lookup({ topic: 'reference/graph-behavior-1', part: first.parts + 1 })).toMatchObject({ ok: false, code: 'docs_part_out_of_range' });
  });

  it('searches topic names and titles, then section text; an unknown topic suggests some', () => {
    const q = manual.lookup({ query: 'editBlocks' });
    expect(q.ok && q.kind === 'query' && q.matches[0]?.topic === 'op.editBlocks').toBe(true);
    const many = manual.lookup({ query: 'node' });
    expect(many.ok && many.kind === 'query' && many.matches.length === DOCS_QUERY_MAX && many.total > DOCS_QUERY_MAX).toBe(true);
    const terrain = manual.lookup({ query: 'terrain sculpt' });
    expect(terrain.ok && terrain.kind === 'query' && terrain.matches.some((m) => m.topic.startsWith('guides/terrain'))).toBe(true);
    const missing = manual.lookup({ topic: 'op.editBlock' });
    expect(missing).toMatchObject({ ok: false, code: 'docs_topic_not_found' });
    expect(!missing.ok && missing.suggestions?.some((s) => s.topic === 'op.editBlocks')).toBe(true);
  });
});
