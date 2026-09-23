/**
 * Dev tool (D21): remove unused named imports from the given files, using
 * TypeScript's own unused-identifier diagnostics (6133/6192/6196).
 *   node tools/dev/prune-imports.mjs <tsconfig> <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const [project, ...files] = process.argv.slice(2);
const targets = new Set(files.map((f) => resolve(f)));
const cfg = ts.getParsedCommandLineOfConfigFile(project, { noUnusedLocals: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
for (let pass = 0; pass < 3; pass += 1) {
  const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noUnusedLocals: true, noEmit: true });
  let changed = 0;
  for (const sf of program.getSourceFiles()) {
    if (!targets.has(resolve(sf.fileName))) continue;
    const unused = new Set();
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (![6133, 6192, 6196, 6198].includes(d.code) || d.start === undefined) continue;
      unused.add(d.start);
    }
    // Every import declaration: drop unused specifiers (and the whole declaration when all are unused).
    const edits = [];
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause) continue;
      const whole = unused.has(st.getStart(sf)) || unused.has(st.importClause.getStart(sf));
      const nb = st.importClause.namedBindings;
      const def = st.importClause.name;
      const specs = nb && ts.isNamedImports(nb) ? nb.elements : [];
      const keep = specs.filter((e) => !unused.has(e.getStart(sf)) && !unused.has(e.name.getStart(sf)));
      const keepDefault = def && !unused.has(def.getStart(sf));
      if (whole || (keep.length === 0 && !keepDefault && !(nb && ts.isNamespaceImport(nb)))) {
        edits.push([st.getFullStart(), st.getEnd(), '']);
      } else if (keep.length !== specs.length) {
        const typeOnly = st.importClause.isTypeOnly ? 'type ' : '';
        const text = `import ${typeOnly}${keepDefault ? def.text + ', ' : ''}{ ${keep.map((e) => e.getText(sf)).join(', ')} } from ${st.moduleSpecifier.getText(sf)};`;
        edits.push([st.getStart(sf), st.getEnd(), text]);
      }
    }
    if (edits.length === 0) continue;
    let text = sf.text;
    for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) text = text.slice(0, a) + r + text.slice(b);
    writeFileSync(sf.fileName, text);
    changed += edits.length;
  }
  if (changed === 0) break;
}
