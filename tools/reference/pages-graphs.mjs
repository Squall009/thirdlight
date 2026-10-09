/**
 * Reference pages for the node graphs: every registered graph kind
 * (visual scripts, material graphs, effects, animator layers, dialogue,
 * generated architecture's styles, presets, room programs and furnishing
 * sets…) with its port types and its node catalogue, from project-model's
 * `GRAPH_KINDS`.
 */
import { code, json, page, ref, section, slug, splitPages, table } from './markdown.mjs';

/** The framework's own test kind has no runtime meaning, so it is not documented as a feature. */
const UNDOCUMENTED_KINDS = new Set(['test']);

function portLine(p, input) {
  const tags = [];
  if (p.required === true) tags.push('required');
  if (p.multi === true) tags.push('takes several wires');
  if (p.single === true) tags.push('one wire');
  if (p.default !== undefined && input) tags.push(`unconnected: ${json(p.default)}`);
  if (p.typeFrom !== undefined) tags.push(`type from field ${code(p.typeFrom.field)}`);
  if (p.repeat !== undefined) tags.push(`repeated by field ${code(p.repeat.field)} (up to ${p.repeat.max})`);
  return `- ${code(p.id)} ${p.label !== p.id ? `"${p.label}" ` : ''}(${p.type})${tags.length > 0 ? `: ${tags.join(', ')}` : ''}`;
}

function fieldRange(f) {
  const parts = [];
  if (f.min !== undefined || f.max !== undefined) parts.push(`${f.min ?? ''} – ${f.max ?? ''}`);
  if (f.options !== undefined) parts.push(f.options.map(code).join(', '));
  if (f.size !== undefined) parts.push(`${f.size} components`);
  if (f.maxLength !== undefined) parts.push(`≤ ${f.maxLength} chars`);
  if (f.pattern !== undefined) parts.push(`matches ${code(f.pattern)}`);
  if (f.asset !== undefined) parts.push(`a ${f.asset} asset`);
  return parts.join('; ');
}

function nodeSection(kind, n) {
  const lines = [];
  if (n.description !== undefined) lines.push(n.description, '');
  const flags = [];
  if (n.required === true) flags.push('every graph needs one');
  if (n.max !== undefined) flags.push(`at most ${n.max} per graph`);
  if (n.fixed === true) flags.push('part of every graph, not in the catalogue');
  if (n.exclusive !== undefined) flags.push(`one node of the ${code(n.exclusive)} group`);
  if (n.portsFrom !== undefined) flags.push(`its ports are the interface of the ${code(n.portsFrom.kind)} graph named by ${code(n.portsFrom.field)}`);
  if (flags.length > 0) lines.push(`(${flags.join('; ')})`, '');
  if (n.inputs.length > 0) lines.push('Inputs:', '', ...n.inputs.map((p) => portLine(p, true)), '');
  if (n.outputs.length > 0) lines.push('Outputs:', '', ...n.outputs.map((p) => portLine(p, false)), '');
  if ((n.fields ?? []).length > 0) lines.push('Fields:', '', table(['Field', 'Label', 'Type', 'Default', 'Range'], n.fields.map((f) => [code(f.key), f.label, f.type, json(f.default), fieldRange(f)])));
  return section(`node-${slug(kind.kind)}--${slug(n.type)}`, `${n.label} (${code(n.type)})`, lines.join('\n'), { level: 3, topics: [`node.${kind.kind}.${n.type}`] });
}

export function graphPages(kinds) {
  const pages = [];
  const index = [];
  // Kinds share nodes (a script's functions use the visual-script catalogue): a node identical to
  // one already documented links there instead of repeating it.
  const documented = new Map();
  for (const kind of Object.values(kinds)) {
    if (UNDOCUMENTED_KINDS.has(kind.kind)) continue;
    const stem = `graph-${slug(kind.kind)}`;
    const facts = [
      `- Graph kind: ${code(kind.kind)}`,
      `- Stored in: ${kind.owner !== undefined ? `the ${code(kind.owner)} documents that own it` : 'standalone graphs (`content.graphs`)'}`,
      `- Node budget: ${kind.maxNodes}`,
      `- Cycles: ${kind.allowCycles ? 'allowed' : 'refused'}`,
    ];
    if (kind.sinks !== undefined) facts.push(`- Results: ${kind.sinks.map(code).join(', ')} (a node reaching none gets a warning)`);
    if (kind.anyType !== undefined) facts.push(`- Wildcard port type: ${code(kind.anyType)}`);
    if (kind.interface !== undefined) facts.push(`- Callable from other graphs: ${code(kind.interface.input)} nodes are its inputs, ${code(kind.interface.output)} nodes its outputs`);
    let overview = `${facts.join('\n')}\n\nPort types:\n\n${table(['Type', 'Label'], kind.portTypes.map((t) => [code(t.id), t.label]))}`;
    if (kind.conversions.length > 0) overview += `\nImplicit conversions:\n\n${kind.conversions.map((c) => `- ${c.label}`).join('\n')}\n`;
    const sections = [section(`graph-${slug(kind.kind)}`, kind.label, overview, { topics: [`graph.${kind.kind}`] })];
    const categories = [...new Set([...kind.categories, ...kind.nodes.map((n) => n.category)])];
    for (const cat of categories) {
      const nodes = kind.nodes.filter((n) => n.category === cat);
      if (nodes.length === 0) continue;
      const own = [];
      const lines = [];
      for (const n of nodes) {
        const key = JSON.stringify(n);
        const at = documented.get(key);
        if (at === undefined) {
          const s = nodeSection(kind, n);
          documented.set(key, { section: s, kind: kind.kind });
          own.push(s);
          lines.push(`- ${n.label} (${code(n.type)})${n.description !== undefined ? `: ${n.description.split('\n')[0]}` : ''}`);
        } else {
          at.section.topics.push(`node.${kind.kind}.${n.type}`);
          lines.push(`- ${ref(at.section.id, n.label)} (${code(n.type)}, as in ${code(at.kind)})${n.description !== undefined ? `: ${n.description.split('\n')[0]}` : ''}`);
        }
      }
      sections.push(section(`graph-${slug(kind.kind)}--${slug(cat)}`, cat, lines.join('\n'), { topics: [`graph.${kind.kind}.${cat}`] }));
      sections.push(...own);
    }
    const parts = splitPages(stem, `Graph: ${kind.label}`, `The ${kind.label} node catalogue: port types, then each category\'s nodes with their inputs, outputs and fields.`, sections, (i, first) => ({ stem: String(i + 1), title: `part ${i + 1}, from ${first.title}` }));
    pages.push(...parts);
    index.push([`[${kind.label}](${parts[0].file})`, code(kind.kind), String(kind.nodes.length), kind.owner ?? 'standalone']);
  }
  pages.unshift(page('graphs.md', 'Node graphs', 'Every graph kind the engine registers, with its node catalogue.', [section('graph-index', 'Graph kinds', table(['Kind', 'Id', 'Nodes', 'Stored in'], index), { topics: ['graphs'] })]));
  return pages;
}
