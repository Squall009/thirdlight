/**
 * The MCP tools page prints every tool's full text, area by area, word for
 * word: what left the short tool descriptions is reachable through tl_docs
 * (`tool.<name>`, `tool.tl_command.<area>`).
 */
import { describe, expect, it } from 'vitest';

import * as docs from '../../packages/mcp-adapter/src/tool-docs';
import { pageText } from './markdown.mjs';
import { toolPages } from './pages-tools.mjs';

describe('the MCP tools reference page', () => {
  const pages = toolPages(docs);
  const text = pages.map(pageText).join('\n').replace(/\\</g, '<');
  const topics = new Set(pages.flatMap((p) => p.sections.flatMap((s) => s.topics)));

  it('holds every area of every tool and answers a topic for each', () => {
    for (const name of Object.keys(docs.TOOL_SUMMARIES)) expect(topics.has(`tool.${name}`), name).toBe(true);
    for (const name of Object.keys(docs.TOOL_DETAILS)) {
      for (const area of docs.toolDocSections(name)) {
        expect(text.includes(area.text), `${name} ${area.id}`).toBe(true);
        if (area.id !== 'all') expect(topics.has(`tool.${name}.${area.id}`)).toBe(true);
      }
    }
  });
});
