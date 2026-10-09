/**
 * The generated reference (docs/manual/reference) stays what the engine
 * source says: regenerating it gives the checked-in pages byte for byte, every
 * op, component, content block and graph kind has its lookup topic, and every
 * topic and link lands on a real anchor.
 */
import { describe, expect, it } from 'vitest';

import { REGENERATE, generateReference, staleFiles } from './gen-reference.mjs';
import { PAGE_BYTES_MAX } from './reference/markdown.mjs';
import { loadValues } from './reference/values.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const generated = await generateReference();
const index = JSON.parse(generated.get('index.json'));

describe('generated reference (tools/gen-reference.mjs)', () => {
  it('the checked-in pages are current', () => {
    const stale = staleFiles(generated);
    expect(stale, `stale reference pages: ${stale.join(', ')} — run ${REGENERATE}`).toEqual([]);
  });

  it('generates the same text twice (no dates, no machine state)', async () => {
    const again = await generateReference();
    expect([...again.keys()]).toEqual([...generated.keys()]);
    for (const [file, text] of again) expect(text === generated.get(file), file).toBe(true);
    // A whole second generation (bundle, compiler program, pages): seconds alone, more beside the full suite.
  }, 60_000);

  it('keeps every page small enough to read in one lookup', () => {
    for (const [file, text] of generated) {
      if (file === 'index.json') continue;
      expect(Buffer.byteLength(text), file).toBeLessThanOrEqual(PAGE_BYTES_MAX);
    }
  });

  it('every topic and every link lands on an anchor of an existing page', () => {
    const anchors = new Map([...generated].map(([file, text]) => [file, new Set([...text.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]))]));
    for (const [topic, at] of Object.entries(index.topics)) {
      expect(anchors.has(at.page), `${topic} → ${at.page}`).toBe(true);
      if (at.section !== undefined) expect(anchors.get(at.page).has(at.section), `${topic} → ${at.page}#${at.section}`).toBe(true);
    }
    for (const [file, text] of generated) {
      for (const m of text.matchAll(/\]\(([a-z0-9-]*\.md)?(?:#([^)]+))?\)/g)) {
        const target = m[1] ?? file;
        expect(anchors.has(target), `${file} links to ${m[0]}`).toBe(true);
        if (m[2] !== undefined) expect(anchors.get(target).has(m[2]), `${file} links to ${m[0]}`).toBe(true);
      }
    }
  });

  it('covers every op, component, content block and graph kind the engine has', async () => {
    const values = await loadValues(ROOT);
    const pm = values['project-model'];
    const expected = [
      ...values['commands'].MUTATION_OPS.map((op) => `op.${op}`),
      ...pm.DESCRIPTORS.components.map((c) => `component.${c.name}`),
      ...pm.DESCRIPTORS.content.map((b) => `content.${b.key}`),
      ...Object.keys(pm.GRAPH_KINDS)
        .filter((k) => k !== 'test')
        .map((k) => `graph.${k}`),
      ...Object.values(pm.GRAPH_KINDS)
        .filter((k) => k.kind !== 'test')
        .flatMap((k) => k.nodes.map((n) => `node.${k.kind}.${n.type}`)),
      'ctx',
      'limits',
    ];
    const missing = expected.filter((t) => index.topics[t] === undefined);
    expect(missing, 'topics without a page').toEqual([]);
  });

  it('prints every argument an op takes, including the scene the workspace reads before the validator', async () => {
    const values = await loadValues(ROOT);
    const routing = values['workspace/scene-routing'];
    const routed = Object.keys(routing.SCENE_ROUTED_CREATES);
    expect(routed.length).toBeGreaterThan(0);
    const detail = [...generated].filter(([file]) => file.startsWith('ops-detail')).map(([, text]) => text).join('\n');
    for (const op of routed) {
      expect(values['commands'].MUTATION_OPS, op).toContain(op);
      // The op's section runs from its anchor to the next one.
      const at = detail.indexOf(`<a id="op-${op}"></a>`);
      expect(at, op).toBeGreaterThanOrEqual(0);
      const end = detail.indexOf('<a id="op-', at + 1);
      const section = detail.slice(at, end === -1 ? undefined : end);
      expect(section, `${op} does not show ${routing.SCENE_ROUTED_ARG}`).toContain(`${routing.SCENE_ROUTED_ARG}?: string`);
    }
  });
});
