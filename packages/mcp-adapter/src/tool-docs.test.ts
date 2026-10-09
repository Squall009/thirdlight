/**
 * Tool descriptions stay short, and nothing that left them is lost: every
 * tool's full text is in its areas (tools/reference/pages-tools.test.mjs
 * checks that the reference prints every area).
 */
import { describe, expect, it } from 'vitest';

import { TOOL_DEFINITIONS } from './tools';
import { TOOL_DETAILS, TOOL_SUMMARIES, toolDocSections } from './tool-docs';

/** The most characters one tool description may carry: every session loads every description. */
const DESCRIPTION_BUDGET = 1_200;
/** All descriptions together. */
const DESCRIPTIONS_BUDGET = 9_000;

describe('MCP tool descriptions', () => {
  it('stay within their budget and point at tl_docs for the rest', () => {
    const sizes = TOOL_DEFINITIONS.map((t) => [t.name, t.description.length] as const);
    for (const [name, size] of sizes) expect(size, name).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
    expect(sizes.reduce((n, [, s]) => n + s, 0)).toBeLessThanOrEqual(DESCRIPTIONS_BUDGET);
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.startsWith(TOOL_SUMMARIES[t.name as keyof typeof TOOL_SUMMARIES]), t.name).toBe(true);
      if (t.name in TOOL_DETAILS && TOOL_DETAILS[t.name as keyof typeof TOOL_DETAILS] !== t.description) {
        expect(t.description, t.name).toContain(`tl_docs {topic: "tool.${t.name}"}`);
      }
    }
  });

  it('have a summary and full text for every tool, and no text for a tool that does not exist', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
    expect(Object.keys(TOOL_SUMMARIES).sort()).toEqual(names);
    for (const name of Object.keys(TOOL_DETAILS)) expect(names).toContain(name);
  });

  it('lose nothing: the areas make up the full text', () => {
    for (const name of Object.keys(TOOL_DETAILS) as (keyof typeof TOOL_DETAILS)[]) {
      const areas = toolDocSections(name);
      expect(areas.map((a) => a.text).join(' ').replace(/\s+/g, ' '), name).toBe(TOOL_DETAILS[name].trim().replace(/\s+/g, ' '));
    }
    expect(toolDocSections('tl_command').length).toBeGreaterThan(20);
  });
});
