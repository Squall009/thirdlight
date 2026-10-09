/**
 * The MCP tools page: what each tool of the MCP server takes and returns, in
 * full. The tool descriptions an agent loads with every session are short
 * summaries that point here (`tl_docs {topic: "tool.<name>"}`), so the long
 * texts live in the adapter (`@thirdlight/mcp-adapter/tool-docs`) and reach
 * agents and people through this page.
 */
import { code, ref, section, splitPages } from './markdown.mjs';

/** Tool text as a markdown paragraph: a `<` that would open an HTML tag is escaped, nothing else changes. */
export function toolParagraph(text) {
  return text.replace(/</g, '\\<');
}

export function toolPages(docs) {
  const names = Object.keys(docs.TOOL_SUMMARIES).sort();
  const sections = [];
  for (const name of names) {
    const summary = docs.TOOL_SUMMARIES[name];
    if (!(name in docs.TOOL_DETAILS)) {
      sections.push(section(`tool-${name}`, code(name), toolParagraph(summary), { topics: [`tool.${name}`] }));
      continue;
    }
    const areas = docs.toolDocSections(name);
    if (areas.length === 1) {
      sections.push(section(`tool-${name}`, code(name), `${toolParagraph(summary)}\n\nIn full:\n\n${toolParagraph(areas[0].text)}`, { topics: [`tool.${name}`] }));
      continue;
    }
    const list = areas.map((a) => `- ${ref(`tool-${name}-${a.id}`, a.title)} (\`tool.${name}.${a.id}\`)`).join('\n');
    sections.push(section(`tool-${name}`, code(name), `${toolParagraph(summary)}\n\nIn full, by area:\n\n${list}`, { topics: [`tool.${name}`] }));
    for (const a of areas) sections.push(section(`tool-${name}-${a.id}`, `${code(name)}: ${a.title}`, toolParagraph(a.text), { level: 3, topics: [`tool.${name}.${a.id}`] }));
  }
  const intro =
    'What each tool of the MCP server takes and returns. The descriptions an agent sees in `tools/list` are short summaries pointing here; ' +
    'read a tool with `tl_docs {topic: "tool.<name>"}` and an area of `tl_command` with `tool.tl_command.<area>`. ' +
    'Op argument shapes are on [Command ops](ops.md); component fields on the component pages.';
  return splitPages('mcp-tools', 'MCP tools', intro, sections, (i, first) => ({ stem: String(i + 1), title: `part ${i + 1}, from ${first.title.replace(/`/g, '')}` }));
}
