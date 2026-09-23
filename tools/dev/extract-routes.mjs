/**
 * Dev tool (D21): move a range of createBackend's closures into a module.
 *
 *   node tools/dev/extract-routes.mjs <startMarker> <endMarker> <module> <factory>
 *
 * The range runs from the line starting with `  const <startMarker> =` (plus
 * its leading doc comment) up to (excluding) the doc comment / line of
 * `  const <endMarker> =`. The block's own closures stay byte-identical;
 * the names it needs from createBackend's scope arrive through a typed
 * context whose field types are read from the compiler.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const [startName, endName, moduleName, factory] = process.argv.slice(2);
const FILE = 'packages/backend/src/backend.ts';
const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');

function declLine(name) {
  const i = lines.findIndex((l) => new RegExp(`^  const ${name} =`).test(l));
  if (i < 0) throw new Error(`no const ${name}`);
  // include a directly preceding doc comment block / line comments
  let j = i;
  while (j > 0 && /^  (\/\*\*|\*|\/\/| \*)/.test(lines[j - 1])) j -= 1;
  while (j > 0 && /^\s*$/.test(lines[j - 1]) === false && /^  \*\//.test(lines[j - 1])) j -= 1;
  return j;
}
const a = declLine(startName);
const b = endName === '-' ? lines.findIndex((l) => /^  const backend: Backend = \{/.test(l)) : declLine(endName);
const block = lines.slice(a, b);
const declared = [...new Set(block.map((l) => /^  const ([A-Za-z_$][\w$]*) =/.exec(l)?.[1]).filter(Boolean))];

// Free identifiers the block uses from createBackend's scope: every
// identifier declared at 2-space indent in createBackend (const/let/function)
// outside the block, that appears in the block.
const cbStart = lines.findIndex((l) => l.startsWith('export function createBackend('));
const scopeNames = new Map(); // name -> line index
for (let i = cbStart; i < lines.length; i += 1) {
  if (i >= a && i < b) continue;
  const m = /^  (?:const|let) ([A-Za-z_$][\w$]*)\b/.exec(lines[i]);
  if (m) scopeNames.set(m[1], i);
  const d = /^  const \{ ([^}]+) \} = /.exec(lines[i]);
  if (d) for (const n of d[1].split(',').map((x) => x.trim().split(':').pop().trim())) scopeNames.set(n, i);
}
// createBackend parameters
// Code only: strip comments and string literals before matching names.
const blockText = block
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
const used = [...scopeNames.keys()].filter((n) => new RegExp(`(?<![\\w$.])${n.replace('$', '\\$')}(?![\\w$])`).test(blockText));
for (const p of ['config']) if (new RegExp(`\\b${p}\\b`).test(blockText) && !used.includes(p)) used.push(p);
const mutable = used.filter((n) => new RegExp(`^  let ${n}\\b`).test(lines[scopeNames.get(n) ?? -1] ?? ''));
if (mutable.length > 0) throw new Error(`block uses mutable bindings (needs a getter): ${mutable.join(', ')}`);

// Field types from the compiler.
const program = ts.createProgram([FILE], { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(FILE);
const types = new Map();
function visit(node) {
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && used.includes(node.name.text) && !types.has(node.name.text)) {
    const t = checker.getTypeAtLocation(node.name);
    types.set(node.name.text, checker.typeToString(t, node, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.WriteArrowStyleSignature));
  }
  ts.forEachChild(node, visit);
}
visit(sf);
const missing = used.filter((n) => !types.has(n));
if (missing.length) throw new Error(`no type for ${missing.join(', ')}`);

// Import header: backend.ts's own imports (same directory).
const importEnd = lines.findIndex((l, i) => i > 0 && /^(const|function|export|let|\/\*\*)/.test(l) && !/^export (type )?\{/.test(l) && i > 15);
const imports = lines.slice(0, importEnd).filter((l, i, arr) => {
  return true;
}).join('\n').replace(/^\/\*\*[\s\S]*?\*\/\n/, '').replace(/^export \{ MAX_DIAGNOSTICS[^\n]*\n/m, '');
const ctxName = factory.replace(/^make/, '') + 'Context';
const iface = `export interface ${ctxName} {\n${used.map((n) => `  readonly ${n}: ${types.get(n).replace(/import\("[^"]*"\)\./g, '').replace(/^BehaviorCompiler$/, 'ReturnType<typeof createBehaviorCompilerPort>')};`).join('\n')}\n}\n`;
const body =
  `${imports}\nimport type { Backend, Problem } from './backend';\n\n` +
  iface +
  `\nexport function ${factory}(ctx: ${ctxName}) {\n  const { ${used.join(', ')} } = ctx;\n\n` +
  block.join('\n') +
  `\n\n  return { ${declared.join(', ')} };\n}\n`;
writeFileSync(`packages/backend/src/${moduleName}.ts`, body);

// backend.ts: drop the block, add the factory call before `const backend: Backend`.
const out = [...lines.slice(0, a), ...lines.slice(b)];
const at = out.findIndex((l) => /^  const backend: Backend = \{/.test(l));
out.splice(at, 0, `  const { ${declared.join(', ')} } = ${factory}({ ${used.join(', ')} });`, '');
// import the factory
const lastImport = out.findIndex((l) => l.startsWith("import { PlayManager"));
out.splice(lastImport + 1, 0, `import { ${factory} } from './${moduleName}';`);
writeFileSync(FILE, out.join('\n'));
console.log(`${moduleName}: moved ${b - a} lines, ${declared.length} closures; context: ${used.join(', ')}`);
