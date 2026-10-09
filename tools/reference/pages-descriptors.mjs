/**
 * Reference pages from project-model's descriptor registry: an object's own
 * fields and the component list, the components by category, the project's
 * content documents, a scene's environment and the UI document fields.
 */
import { fieldTable } from './fields.mjs';
import { code, json, page, ref, section, slug, splitPages, table } from './markdown.mjs';

function conditionText(when) {
  const list = Array.isArray(when) ? when : [when];
  return list.map((c) => `${code(c.key)} is ${c.in.map((v) => code(v)).join(' or ')}`).join(' and ');
}

function addText(add) {
  switch (add.kind) {
    case 'menu':
      return `from "+ Add component", starting as ${json(add.value)}`;
    case 'pick':
      return `from "+ Add component" after picking ${add.pick.map(code).join(', ')} (the rest starts as ${json(add.value)})`;
    case 'tool':
      return `by a tool: ${add.tool}`;
    default:
      return `never by hand: ${add.reason}`;
  }
}

function componentSection(c) {
  const facts = [
    `- Category: ${c.category}`,
    `- Added: ${addText(c.add)}`,
    `- On prefab objects: ${c.prefab ? 'yes' : 'no'}`,
  ];
  if (c.legacy === true) facts.push('- Legacy: kept working for old data, not offered for new objects');
  if (c.requiresAnyOf !== undefined) facts.push(`- Needs one of ${c.requiresAnyOf.components.map((n) => ref(`component-${n}`, code(n))).join(', ')} on the same object: ${c.requiresAnyOf.reason}`);
  for (const e of c.excludes) facts.push(`- Cannot share an object with ${ref(`component-${e.component}`, code(e.component))}: ${e.reason}`);
  if (c.icon !== undefined) facts.push(`- Icon: ${c.icon}`);
  if (c.rules !== undefined) for (const r of c.rules) facts.push(`- Rule: ${r}`);
  if (c.value.type === 'object' && c.value.rules !== undefined) for (const r of c.value.rules) facts.push(`- Rule: ${r}`);
  let body = `${c.tooltip}\n\n${facts.join('\n')}\n\n${fieldTable(c.value)}`;
  if (c.handles.length > 0) {
    body += `\nScene-view handles:\n\n${table(
      ['Handle', 'Kind', 'Edits', 'Space', 'Shown when'],
      c.handles.map((h) => [h.label, h.kind, Object.entries(h.bind).map(([role, ptr]) => `${role} → ${code(ptr)}`).join(', '), `${h.space}${h.follows !== undefined ? ` (follows ${h.follows})` : ''}`, [h.when === undefined ? '' : conditionText(h.when), h.dimension === undefined ? '' : `${h.dimension}D`].filter((x) => x !== '').join('; ')]),
    )}`;
  }
  if (c.presets !== undefined && c.presets.length > 0) {
    body += `\nPresets:\n\n${c.presets.map((p) => `- ${p.label}${p.dimension !== undefined ? ` (${p.dimension}D)` : ''}${p.requires !== undefined ? ` (needs ${p.requires.map(code).join(', ')})` : ''}: ${json(p.value)}`).join('\n')}\n`;
  }
  if (c.create !== undefined && c.create.length > 0) {
    body += `\nGameObject menu: ${c.create.map((e) => `${e.menu !== undefined ? `${e.menu} → ` : ''}${e.label}${e.dimension !== undefined ? ` (${e.dimension}D)` : ''}`).join(', ')}\n`;
  }
  return section(`component-${c.name}`, `${c.name} — ${c.label}`, body, { topics: [`component.${c.name}`] });
}

export function descriptorPages(D) {
  const pages = [];
  const categories = [...new Set(D.components.map((c) => c.category))];

  // The object page: an entity's own fields and the component index.
  const index = table(
    ['Component', 'Name', 'Category', 'What it does'],
    D.components.map((c) => [ref(`component-${c.name}`, code(c.name)), c.label, c.category, c.tooltip]),
  );
  pages.push(
    page('objects.md', 'Objects and components', 'An object (entity) is a node of a scene: its own fields below, and components that give it a look, physics, gameplay and scripts. Components are set with the `setComponent` op (or the Inspector).', [
      section('entity', 'Object fields', `${D.entity.tooltip}\n\n${fieldTable(D.entity)}`, { topics: ['entity'] }),
      section('component-index', 'Components', `Every component, in "+ Add component" order within its category.\n\n${index}`, { topics: ['components'] }),
      section(
        'handle-kinds',
        'Scene-view handle kinds',
        `The handles the Scene view draws and drags, and the field roles each binds (alternative sets).\n\n${table(['Kind', 'Roles'], D.handleKinds.map((k) => [k, D.handleRoles[k].map((set) => set.join(' + ')).join(' or ')]))}`,
        { topics: ['handles'] },
      ),
    ]),
  );
  for (const cat of categories) {
    const comps = D.components.filter((c) => c.category === cat);
    pages.push(...splitPages(`components-${slug(cat)}`, `Components: ${cat}`, `The ${cat} components. Fields list the stored keys; paths with \`[]\` are list items and \`{}\` map values.`, comps.map(componentSection), (i) => ({ stem: String(i + 1), title: `part ${i + 1}` })));
  }

  // Content documents.
  const contentSections = D.content.map((b) => {
    const ops = b.ops.map((op) => ref(`op-${op}`, code(op))).join(', ');
    const body = `${b.tooltip}\n\n- In every project: ${b.required ? 'yes' : 'no'}\n- Written by: ${ops}\n\n${fieldTable(b.value)}`;
    return section(`content-${b.key}`, `${b.key} — ${b.label}`, body, { topics: [`content.${b.key}`] });
  });
  const contentIndex = table(
    ['Block', 'Name', 'Written by'],
    D.content.map((b) => [ref(`content-${b.key}`, code(b.key)), b.label, b.ops.map(code).join(', ')]),
  );
  pages.push(page('content.md', 'Content documents', 'The project\'s content: one block per kind of document. Each block lists the ops that write it (the one mutation path).', [section('content-index', 'Content blocks', contentIndex, { topics: ['content'] })]));
  pages.push(...splitPages('content-blocks', 'Content documents', 'The project\'s content blocks and their fields. Paths with `[]` are list items and `{}` map values.', contentSections, (i, first, last) => ({ stem: `${slug(first.id.slice('content-'.length))}`, title: `${first.id.slice('content-'.length)} to ${last.id.slice('content-'.length)}` })));

  if (D.sceneEnvironment !== undefined) {
    const env = D.sceneEnvironment;
    pages.push(
      page('scene-environment.md', 'Scene environment', 'Each scene document\'s `environment`: its look. Set with `setEnvironment {sceneId, environment}`.', env.fields.map((f) => section(`scene-environment-${slug(f.key)}`, `${f.key} — ${f.label}`, `${f.tooltip}\n\n${fieldTable({ ...env, fields: [f] })}`, { topics: [`scene-environment.${f.key}`] })), ['scene-environment']),
    );
  }
  if (D.ui !== undefined) {
    const parts = [
      ['document', 'UI document'],
      ['widget', 'Widget'],
      ['style', 'Style'],
      ['tween', 'Tween'],
    ];
    pages.push(
      page(
        'ui.md',
        'UI documents',
        'The fields of a UI document, a widget, a style and a tween (`content.uiDocuments`, `content.uiThemes`; set with `setUiDocument` and `setUiTheme`).',
        parts.map(([k, title]) => section(`ui-${k}`, title, `${D.ui[k].tooltip}\n\n${fieldTable(D.ui[k])}`, { topics: [`ui.${k}`] })),
      ),
    );
  }
  return pages;
}
