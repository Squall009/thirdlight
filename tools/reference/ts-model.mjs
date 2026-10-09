/**
 * What the reference reads from the TypeScript sources themselves (with the
 * pinned compiler API): the request shape of every command op, from the
 * validator's per-op union (`ValidatedOpArgs`), the declarations those shapes
 * name, and the doc comment and owning file of every exported constant.
 */
import { join, relative } from 'node:path';

import ts from 'typescript';

const OP_UNION = 'ValidatedOpArgs';
const OP_UNION_FILE = 'packages/commands/src/validate-request.ts';

function isWorkspaceSource(fileName) {
  return fileName.includes('/packages/') && !fileName.includes('/node_modules/') && !fileName.endsWith('.d.ts');
}

export function createModelProgram(root, packages) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
    types: [],
  };
  return ts.createProgram(
    packages.map((p) => join(root, 'packages', p, 'src', 'index.ts')),
    options,
  );
}

function resolveAlias(checker, symbol) {
  let s = symbol;
  for (let guard = 0; s !== undefined && s.flags & ts.SymbolFlags.Alias && guard < 16; guard++) s = checker.getAliasedSymbol(s);
  return s;
}

function jsDoc(node) {
  const docs = ts.getJSDocCommentsAndTags(node).filter((d) => d.kind === ts.SyntaxKind.JSDoc);
  return docs[docs.length - 1];
}

/** A doc comment's text without the comment markers. */
function docText(node) {
  const d = jsDoc(node);
  if (d === undefined) return '';
  const comment = typeof d.comment === 'string' ? d.comment : ts.getTextOfJSDocComment(d.comment) ?? '';
  return comment.trim();
}

/** Inline `import('@thirdlight/x').Name` reads as `Name` in the reference. */
function plainTypeText(text) {
  return text.replace(/import\('[^']+'\)\./g, '');
}

function declarationText(node) {
  const d = jsDoc(node);
  const doc = d === undefined ? '' : `${d.getText()}\n`;
  return plainTypeText(doc + node.getText().replace(/^export\s+/, '').replace(/^declare\s+/, ''));
}

/** The workspace symbols a type node names (type references, `import()` types, `typeof X`). */
function namedSymbols(checker, node, out) {
  const add = (sym) => {
    const s = resolveAlias(checker, sym);
    if (s !== undefined && !(s.flags & ts.SymbolFlags.TypeParameter) && (s.declarations ?? []).some((d) => isWorkspaceSource(d.getSourceFile().fileName))) out.add(s);
  };
  const visit = (n) => {
    if (ts.isTypeReferenceNode(n)) {
      const name = ts.isQualifiedName(n.typeName) ? n.typeName.right : n.typeName;
      const sym = checker.getSymbolAtLocation(name);
      if (sym !== undefined) add(sym);
    } else if (ts.isImportTypeNode(n) && n.qualifier !== undefined) {
      const name = ts.isQualifiedName(n.qualifier) ? n.qualifier.right : n.qualifier;
      const sym = checker.getSymbolAtLocation(name);
      if (sym !== undefined) add(sym);
    } else if (ts.isExpressionWithTypeArguments(n)) {
      const sym = checker.getSymbolAtLocation(n.expression);
      if (sym !== undefined) add(sym);
    } else if (ts.isTypeQueryNode(n)) {
      const name = ts.isQualifiedName(n.exprName) ? n.exprName.left : n.exprName;
      const sym = checker.getSymbolAtLocation(name);
      if (sym !== undefined) add(sym);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** The printable declarations of a symbol (interfaces, type aliases, enums, `typeof` constants). */
function symbolDeclarations(checker, s) {
  const parts = [];
  for (const d of s.declarations ?? []) {
    if (!isWorkspaceSource(d.getSourceFile().fileName)) continue;
    if (ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d)) parts.push({ node: d, text: declarationText(d) });
    else if (ts.isVariableDeclaration(d)) {
      const type = checker.typeToString(checker.getTypeOfSymbolAtLocation(s, d), undefined, ts.TypeFormatFlags.NoTruncation);
      const stmt = d.parent.parent;
      const doc = jsDoc(stmt);
      parts.push({ node: d, text: `${doc === undefined ? '' : `${doc.getText()}\n`}const ${s.name}: ${plainTypeText(type)};` });
    }
  }
  return parts;
}

/**
 * Gathers declarations for the reference's type pages: the symbols added
 * and every workspace type they name, transitively (`done()`: name → {
 * text, file }).
 */
export function typeCollector(program, root) {
  const checker = program.getTypeChecker();
  const types = new Map();
  const queue = [];
  const add = (syms) => {
    for (const s of [...syms].sort((a, b) => a.name.localeCompare(b.name))) {
      if (types.has(s.name)) continue;
      const decls = symbolDeclarations(checker, s);
      if (decls.length === 0) continue;
      types.set(s.name, { text: decls.map((d) => d.text).join('\n'), file: relative(root, decls[0].node.getSourceFile().fileName) });
      queue.push(decls);
    }
  };
  return {
    checker,
    add,
    /** Add types a package exports, by name (an unknown name throws). */
    addExported(pkg, names, what) {
      const entry = program.getSourceFile(join(root, 'packages', pkg, 'src', 'index.ts'));
      const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(entry)).map((e) => [e.name, e]));
      const syms = new Set();
      for (const name of names) {
        const e = exports.get(name);
        if (e === undefined) throw new Error(`gen-reference: ${what} names ${name}, which @thirdlight/${pkg} does not export`);
        syms.add(resolveAlias(checker, e));
      }
      add(syms);
    },
    done() {
      while (queue.length > 0) {
        const decls = queue.shift();
        const named = new Set();
        for (const d of decls) namedSymbols(checker, d.node, named);
        add(named);
      }
      return types;
    },
  };
}

/**
 * Every op's request arguments: `{ op → { argsText, argsName?, types } }`;
 * the types the shapes name go to the collector. An op in `ops` without a
 * member in the union throws.
 */
export function opShapes(program, root, ops, collector) {
  const checker = collector.checker;
  const file = program.getSourceFile(join(root, OP_UNION_FILE));
  if (file === undefined) throw new Error(`gen-reference: ${OP_UNION_FILE} is not in the program`);
  let union;
  ts.forEachChild(file, (n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === OP_UNION) union = n;
  });
  if (union === undefined || !ts.isUnionTypeNode(union.type)) throw new Error(`gen-reference: ${OP_UNION} (a union) not found in ${OP_UNION_FILE}`);
  const byOp = new Map();
  for (const member of union.type.types) {
    if (!ts.isTypeLiteralNode(member)) throw new Error(`gen-reference: a ${OP_UNION} member is not an object type: ${member.getText()}`);
    const prop = (name) => member.members.find((m) => ts.isPropertySignature(m) && m.name.getText() === name);
    const opNode = prop('op')?.type;
    const argsNode = prop('args')?.type;
    if (opNode === undefined || argsNode === undefined) throw new Error(`gen-reference: a ${OP_UNION} member lacks op or args: ${member.getText()}`);
    const literals = ts.isUnionTypeNode(opNode) ? opNode.types : [opNode];
    for (const lit of literals) {
      if (!ts.isLiteralTypeNode(lit) || !ts.isStringLiteral(lit.literal)) throw new Error(`gen-reference: op is not a string literal: ${lit.getText()}`);
      // A repeated member (the same op listed twice) keeps the first.
      if (!byOp.has(lit.literal.text)) byOp.set(lit.literal.text, argsNode);
    }
  }
  const missing = ops.filter((op) => !byOp.has(op));
  if (missing.length > 0) throw new Error(`gen-reference: ops without a ${OP_UNION} member (their request shape is unknown): ${missing.join(', ')}`);
  const out = {};
  for (const op of ops) {
    const node = byOp.get(op);
    const named = new Set();
    namedSymbols(checker, node, named);
    let argsName;
    if (ts.isTypeReferenceNode(node) && named.size >= 1) {
      const s = resolveAlias(checker, checker.getSymbolAtLocation(ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName));
      if (s !== undefined && s.declarations?.[0] !== undefined) argsName = s.name;
    }
    out[op] = { argsText: plainTypeText(node.getText()), argsName, types: [...named].map((s) => s.name).sort() };
    collector.add(named);
  }
  return out;
}

/**
 * The exported constants of each package that declares them: name → {
 * pkg, file, doc }. A constant re-exported by another package is listed
 * once, under the package whose source declares it.
 */
export function constantOwners(program, root, packages) {
  const checker = program.getTypeChecker();
  const out = new Map();
  for (const pkg of packages) {
    const entry = program.getSourceFile(join(root, 'packages', pkg, 'src', 'index.ts'));
    if (entry === undefined) continue;
    const moduleSymbol = checker.getSymbolAtLocation(entry);
    if (moduleSymbol === undefined) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const s = resolveAlias(checker, exp);
      const d = s?.valueDeclaration;
      if (d === undefined || !ts.isVariableDeclaration(d)) continue;
      const fileName = d.getSourceFile().fileName;
      if (!isWorkspaceSource(fileName)) continue;
      const rel = relative(root, fileName);
      const owner = rel.split('/')[1];
      if (out.has(exp.name) && out.get(exp.name).pkg === owner) continue;
      out.set(exp.name, { pkg: owner, file: rel, doc: docText(d.parent.parent) });
    }
  }
  return out;
}

/** The declarations (doc comments included) of the named top-level types of one source file, in the order asked. */
export function declarationsNamed(program, root, file, names) {
  const sf = program.getSourceFile(join(root, file));
  if (sf === undefined) throw new Error(`gen-reference: ${file} is not in the program`);
  const found = new Map();
  ts.forEachChild(sf, (n) => {
    if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && names.includes(n.name.text)) found.set(n.name.text, declarationText(n));
  });
  return names.map((name) => {
    const text = found.get(name);
    if (text === undefined) throw new Error(`gen-reference: ${name} is not declared in ${file}`);
    return text;
  });
}
