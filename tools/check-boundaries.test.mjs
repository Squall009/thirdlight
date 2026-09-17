/**
 * Check tool test suite — boundary check 1 (dependencies.md §5.1;
 * m1-acceptance.md §2.4: "per-edge negative fixtures in the check tool's
 * test suite"). Runs the boundary check against temporary fixture workspaces
 * in the OS temp dir; every forbidden edge of dependencies.md §4.3 has a
 * negative fixture, and the §4.1 allowed edges have positive fixtures.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkspace, extractSpecifiers, UNITS, NODE_SIDE_ALLOWED } from './check-boundaries.mjs';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tl-boundaries-'));
  mkdirSync(join(root, 'packages'), { recursive: true });
  return root;
}

/** Create a fixture package with an exports map, src files, and optional declared deps. */
function addPkg(
  root,
  name,
  {
    exports = { '.': './src/index.ts' },
    files = { 'src/index.ts': 'export const ok = true;\n' },
    dependencies = {},
    devDependencies = {},
  } = {},
) {
  const dir = join(root, 'packages', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: `@thirdlight/${name}`,
        version: '0.0.0',
        private: true,
        exports,
        dependencies,
        devDependencies,
      },
      null,
      2,
    ),
  );
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
}

function firstViolation(result, rule) {
  return result.violations.find((v) => v.rule === rule);
}

describe('check 1 — static import graph (dependencies.md §5.1)', () => {
  it('passes on an empty workspace (no implemented packages yet)', () => {
    const r = checkWorkspace(makeRoot());
    expect(r.violations).toEqual([]);
    expect(r.packages).toEqual([]);
  });

  it('allows the §4.1 node-side allowed edges (positive fixtures)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'commands', {
      files: {
        'src/index.ts':
          "import { x } from '@thirdlight/project-model';\nexport { x };\n",
      },
    });
    addPkg(root, 'three-adapter', {
      files: { 'src/index.ts': "import * as THREE from 'three';\nexport const Scene = THREE.Scene;\n" },
    });
    addPkg(root, 'workspace', {
      files: {
        'src/index.ts':
          "import fs from 'node:fs';\nimport '@thirdlight/commands';\nexport const f = fs;\n",
      },
    });
    addPkg(root, 'backend', {
      files: {
        'src/index.ts':
          "import http from 'node:http';\nimport { WebSocketServer } from 'ws';\nimport { s } from '@thirdlight/workspace';\nimport { t } from '@thirdlight/protocol';\nimport { e } from '@thirdlight/exporter';\nexport const x = [http, WebSocketServer, s, t, e];\n",
      },
    });
    addPkg(root, 'exporter');
    addPkg(root, 'protocol');
    const r = checkWorkspace(root);
    expect(r.violations).toEqual([]);
  });

  it('fails runtime → three (forbidden, dependencies.md §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      files: { 'src/index.ts': "import * as THREE from 'three';\nexport const c = new THREE.Color();\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-external');
    expect(v[0].file).toBe('packages/runtime/src/index.ts');
    expect(v[0].line).toBe(1);
  });

  it('fails runtime → Node builtins (bare and node: forms, dependencies.md §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      files: {
        'src/index.ts':
          "import fs from 'fs';\nimport crypto from 'node:crypto';\nexport const x = [fs, crypto];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'node-builtin-forbidden')).toBe(true);
    expect(vs.map((v) => v.line).sort()).toEqual([1, 2]);
  });

  it('fails runtime → commands | workspace (forbidden edges, §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'commands');
    addPkg(root, 'workspace');
    addPkg(root, 'runtime', {
      files: {
        'src/index.ts':
          "import { apply } from '@thirdlight/commands';\nimport { openWorkspaceService } from '@thirdlight/workspace';\nexport const x = [apply, openWorkspaceService];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'forbidden-edge')).toBe(true);
  });

  it('fails three-adapter → backend (forbidden edge, §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'backend', {
      exports: { '.': './src/index.ts', './services': './src/services.ts' },
      files: {
        'src/index.ts': 'export const server = true;\n',
        'src/services.ts': 'export const services = true;\n',
      },
    });
    addPkg(root, 'three-adapter', {
      files: { 'src/index.ts': "import { services } from '@thirdlight/backend/services';\nexport const x = services;\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-edge');
  });

  it('fails editor → workspace and editor → backend (the editor talks to the backend only over HTTP/WS, §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'workspace');
    addPkg(root, 'backend', {
      exports: { '.': './src/index.ts', './services': './src/services.ts' },
      files: {
        'src/index.ts': 'export const server = true;\n',
        'src/services.ts': 'export const services = true;\n',
      },
    });
    addPkg(root, 'editor', {
      files: {
        'src/index.ts':
          "import { openWorkspaceService } from '@thirdlight/workspace';\nimport { services } from '@thirdlight/backend/services';\nexport const x = [openWorkspaceService, services];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'forbidden-edge')).toBe(true);
  });

  it('fails backend → editor (serving the static bundle ≠ importing editor code, §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'editor');
    addPkg(root, 'backend', {
      files: { 'src/index.ts': "import { App } from '@thirdlight/editor';\nexport const x = App;\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-edge');
  });

  it('fails mcp-adapter → backend root subpath, allows the /services subpath only (§3/§4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'backend', {
      exports: { '.': './src/index.ts', './services': './src/services.ts' },
      files: {
        'src/index.ts': 'export const server = true;\n',
        'src/services.ts': 'export const services = true;\n',
      },
    });
    addPkg(root, 'mcp-adapter', {
      files: {
        'src/bad.ts': "import { server } from '@thirdlight/backend';\nexport const s = server;\n",
        'src/good.ts': "import { services } from '@thirdlight/backend/services';\nexport const g = services;\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('backend-services-only');
    expect(vs[0].file).toBe('packages/mcp-adapter/src/bad.ts');
  });

  it('fails mcp-adapter → workspace (no alternate mutation engine, §4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'workspace');
    addPkg(root, 'mcp-adapter', {
      files: { 'src/index.ts': "import { openWorkspaceService } from '@thirdlight/workspace';\nexport const x = openWorkspaceService;\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-edge');
  });

  it('fails exporter → backend and exporter → editor (§4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'backend', {
      exports: { '.': './src/index.ts', './services': './src/services.ts' },
      files: {
        'src/index.ts': 'export const server = true;\n',
        'src/services.ts': 'export const services = true;\n',
      },
    });
    addPkg(root, 'editor');
    addPkg(root, 'exporter', {
      files: {
        'src/index.ts':
          "import { services } from '@thirdlight/backend/services';\nimport { App } from '@thirdlight/editor';\nexport const x = [services, App];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'forbidden-edge')).toBe(true);
  });

  it('fails a specifier reaching a non-exported subpath (§3: internal files unreachable)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', { exports: { '.': './src/index.ts' } });
    addPkg(root, 'commands', {
      files: {
        'src/index.ts':
          "import { hiddenThing } from '@thirdlight/project-model/internal';\nexport const x = hiddenThing;\n",
      },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('non-exported-subpath');
    expect(v[0].file).toBe('packages/commands/src/index.ts');
  });

  it('fails an import of a not-yet-implemented unit (§2: created only when implemented)', () => {
    const root = makeRoot();
    addPkg(root, 'commands', {
      files: { 'src/index.ts': "import { App } from '@thirdlight/editor';\nexport const x = App;\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('unimplemented-unit');
  });

  it('fails a relative import that escapes into another package (§4.3)', () => {
    const root = makeRoot();
    addPkg(root, 'protocol');
    addPkg(root, 'runtime', {
      files: { 'src/index.ts': "import { s } from '../../protocol/src/index';\nexport const x = s;\n" },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('cross-package-internal');
  });

  it('fails react/react-dom outside editor (React scope rules, dependencies.md §7)', () => {
    const root = makeRoot();
    addPkg(root, 'three-adapter', {
      files: { 'src/index.ts': "import React from 'react';\nimport { createRoot } from 'react-dom';\nexport const x = [React, createRoot];\n" },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'react-outside-editor')).toBe(true);
  });

  it('allows react/react-dom in editor', () => {
    const root = makeRoot();
    addPkg(root, 'editor', {
      files: { 'src/index.ts': "import React from 'react';\nimport { createRoot } from 'react-dom';\nexport const x = [React, createRoot];\n" },
    });
    expect(checkWorkspace(root).violations).toEqual([]);
  });

  it('checks dynamic import() and export … from (dependencies.md §5.1: all three specifier forms)', () => {
    const root = makeRoot();
    addPkg(root, 'commands');
    addPkg(root, 'runtime', {
      files: {
        'src/index.ts':
          "export const p = import('three');\nexport * from '@thirdlight/commands';\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => v.line).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(vs.some((v) => v.rule === 'forbidden-external')).toBe(true);
    expect(vs.some((v) => v.rule === 'forbidden-edge')).toBe(true);
  });

  it('flags globalThis assignments (no hidden global services, §4.3; m1-acceptance §2.4)', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      files: {
        'src/index.ts':
          'export const a = 1;\nglobalThis.__thirdlight = { a };\nglobalThis["__thirdlight2"] = 2;\nif (globalThis.x === 1) { globalThis.y = 3; }\n',
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(3);
    expect(vs.every((v) => v.rule === 'globalthis-assignment')).toBe(true);
  });

  it('fails a web framework in declared dependencies (m1-acceptance §2.4 list)', () => {
    const root = makeRoot();
    addPkg(root, 'three-adapter', { devDependencies: { express: '4.19.2' } });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-framework');
    expect(v[0].file).toBe('packages/three-adapter/package.json');
  });

  it('fails a declared dependency on a not-implemented workspace package (§5.6)', () => {
    const root = makeRoot();
    addPkg(root, 'commands', { dependencies: { '@thirdlight/editor': '0.0.0' } });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('premature-wiring');
  });

  it('flags a stray directory under packages/ without a package.json', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'packages', 'half-done'), { recursive: true });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('stray-packages-dir');
  });

  it('lists the offending file and line (DoD: every violation is file:line)', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      files: { 'src/index.ts': 'export const a = 1;\nimport * as THREE from \'three\';\nexport const c = THREE.Color;\n' },
    });
    const v = checkWorkspace(root).violations[0];
    expect(v.file).toBe('packages/runtime/src/index.ts');
    expect(v.line).toBe(2);
    expect(v.message).toContain("'three'");
  });

  it('covers every unit of the §2 list in the edge table', () => {
    for (const u of UNITS) {
      expect(NODE_SIDE_ALLOWED[u], `edge table row for '${u}'`).toBeDefined();
    }
  });
});

// --- 04-review repair regressions -------------------------------------------

describe('R2 — extraction of the normative import forms (04-review R2)', () => {
  it('extracts default + namespace import (import React, * as panels from …)', () => {
    const specs = extractSpecifiers(
      "import React, * as panels from '@thirdlight/editor';\n",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].spec).toBe('@thirdlight/editor');
    expect(specs[0].kind).toBe('import');
    expect(specs[0].line).toBe(1);
    expect(specs[0].typeOnly).toBe(false);
  });

  it('extracts an import with a comment between tokens', () => {
    const specs = extractSpecifiers(
      "import /* note */ { App } from '@thirdlight/editor';\n",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].spec).toBe('@thirdlight/editor');
    expect(specs[0].line).toBe(1);
  });

  it('extracts a dynamic import with an options argument (the R2 repro form)', () => {
    const specs = extractSpecifiers(
      "const p = import('@thirdlight/editor', {});\n",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].spec).toBe('@thirdlight/editor');
    expect(specs[0].kind).toBe('dynamic-import');
    expect(specs[0].typeOnly).toBe(false);
  });

  it('extracts a dynamic import with a multi-line options object', () => {
    const specs = extractSpecifiers(
      "const p = import('three', {\n  foo: { bar: 1 },\n});\n",
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].spec).toBe('three');
  });

  it('ignores import-like text in comments and string literals', () => {
    const specs = extractSpecifiers(
      "// import 'commented-out';\n" +
        "/* import { x } from 'commented-out-2'; */\n" +
        "const s = 'import \"prose\" from nowhere';\n" +
        "const t = `import 'tpl-prose'`\n" +
        "import real from 'real';\n",
    );
    expect(specs.map((s) => s.spec)).toEqual(['real']);
  });

  it('classifies type-only vs value import/export forms', () => {
    const cases = [
      ["import type { T } from 's';", true],
      ["import type T from 's';", true],
      ["import type * as ns from 's';", true],
      ["import { type A, type B } from 's';", true],
      ["import { type A } from 's';", true],
      ["import { T } from 's';", false],
      ["import T from 's';", false],
      ["import * as ns from 's';", false],
      ["import T, { A } from 's';", false],
      ["import T, * as ns from 's';", false],
      ["import { type A, b } from 's';", false],
      ["import {} from 's';", false],
      ["import 's';", false],
      ["export type { T } from 's';", true],
      ["export type * from 's';", true],
      ["export { T } from 's';", false],
      ["export * from 's';", false],
      ["const p = import('s');", false],
    ];
    for (const [src, typeOnly] of cases) {
      const specs = extractSpecifiers(src);
      expect(specs, src).toHaveLength(1);
      expect(specs[0].typeOnly, src).toBe(typeOnly);
    }
  });

  it('does not pass a runtime with default+namespace editor imports (the R2 repro)', () => {
    const root = makeRoot();
    addPkg(root, 'editor');
    addPkg(root, 'runtime', {
      files: {
        'src/index.ts':
          "import React, * as panels from '@thirdlight/editor';\nexport const x = [React, panels];\n",
      },
    });
    const r = checkWorkspace(root);
    expect(r.specifiersChecked).toBe(1);
    const v = r.violations.find((v) => v.rule === 'forbidden-edge');
    expect(v).toBeDefined();
    expect(v.file).toBe('packages/runtime/src/index.ts');
    expect(v.line).toBe(1);
  });
});

describe('R3 — types-only edges (dependencies.md §4.1 qualifiers)', () => {
  it('fails editor → commands value imports (the R3 repro)', () => {
    const root = makeRoot();
    addPkg(root, 'commands');
    addPkg(root, 'editor', {
      files: {
        'src/index.ts':
          "import { apply } from '@thirdlight/commands';\napply();\nexport const x = true;\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('types-only-edge');
    expect(vs[0].file).toBe('packages/editor/src/index.ts');
    expect(vs[0].line).toBe(1);
  });

  it('fails editor → project-model value imports; allows import type', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'editor', {
      files: {
        'src/bad.ts':
          "import { serializeCanonical } from '@thirdlight/project-model';\nexport const x = serializeCanonical;\n",
        'src/good.ts':
          "import type { Snapshot } from '@thirdlight/project-model';\nexport type S = Snapshot;\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('types-only-edge');
    expect(vs[0].file).toBe('packages/editor/src/bad.ts');
    expect(vs[0].line).toBe(1);
  });

  it('fails backend → project-model value imports; keeps the other backend edges', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'protocol');
    addPkg(root, 'workspace');
    addPkg(root, 'exporter');
    addPkg(root, 'backend', {
      files: {
        'src/bad.ts':
          "import { parseProject } from '@thirdlight/project-model';\nexport const x = parseProject;\n",
        'src/good.ts':
          "import type { Snapshot } from '@thirdlight/project-model';\n" +
          "import { validateWsEvent } from '@thirdlight/protocol';\n" +
          "import { openWorkspaceService } from '@thirdlight/workspace';\n" +
          "import { exportProject } from '@thirdlight/exporter';\n" +
          "export const y = [Snapshot, validateWsEvent, openWorkspaceService, exportProject];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('types-only-edge');
    expect(vs[0].file).toBe('packages/backend/src/bad.ts');
  });

  it('fails exporter → project-model/protocol/workspace value imports; allows type forms', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'protocol');
    addPkg(root, 'workspace');
    addPkg(root, 'exporter', {
      files: {
        'src/bad.ts':
          "import { serializeCanonical } from '@thirdlight/project-model';\n" +
          "import { encodeWsEvent } from '@thirdlight/protocol';\n" +
          "import { openWorkspaceService } from '@thirdlight/workspace';\n" +
          "export const x = [serializeCanonical, encodeWsEvent, openWorkspaceService];\n",
        'src/good.ts':
          "import type { Project } from '@thirdlight/project-model';\n" +
          "import type { WsEvent } from '@thirdlight/protocol';\n" +
          "import type { WorkspaceService } from '@thirdlight/workspace';\n" +
          "export type R = [Project, WsEvent, WorkspaceService];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(3);
    expect(vs.every((v) => v.rule === 'types-only-edge')).toBe(true);
    expect(vs.every((v) => v.file.endsWith('bad.ts'))).toBe(true);
  });

  it('fails protocol → project-model/commands value imports (the §4.1 "(types; pure code, no I/O)" row — recorded interpretation)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'commands');
    addPkg(root, 'protocol', {
      files: {
        'src/bad.ts':
          "import { validateProject } from '@thirdlight/project-model';\n" +
          "import { apply } from '@thirdlight/commands';\n" +
          "export const x = [validateProject, apply];\n",
        'src/good.ts':
          "import type { Project } from '@thirdlight/project-model';\n" +
          "import type { Envelope } from '@thirdlight/commands';\n" +
          "export type W = [Project, Envelope];\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'types-only-edge')).toBe(true);
    expect(vs.map((v) => v.line).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('fails value re-exports and dynamic imports of types-only edges; allows export type', () => {
    const root = makeRoot();
    addPkg(root, 'commands');
    addPkg(root, 'editor', {
      files: {
        'src/reexport.ts': "export { apply } from '@thirdlight/commands';\n",
        'src/dynamic.ts': "const p = import('@thirdlight/commands', {});\nexport const x = p;\n",
        'src/reexport-type.ts': "export type { CommandEnvelope } from '@thirdlight/commands';\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => v.file).sort()).toEqual([
      'packages/editor/src/dynamic.ts',
      'packages/editor/src/reexport.ts',
    ]);
    expect(vs.every((v) => v.rule === 'types-only-edge')).toBe(true);
  });

  it('does not restrict value imports on edges without the types-only qualifier', () => {
    const root = makeRoot();
    addPkg(root, 'project-model');
    addPkg(root, 'commands');
    addPkg(root, 'workspace');
    // commands → project-model and workspace → commands are value edges.
    addPkg(root, 'commands', {
      files: {
        'src/index.ts':
          "import { parseProject } from '@thirdlight/project-model';\nexport const p = parseProject;\n",
      },
    });
    addPkg(root, 'workspace', {
      files: {
        'src/index.ts':
          "import { apply } from '@thirdlight/commands';\nexport const a = apply;\n",
      },
    });
    expect(checkWorkspace(root).violations).toEqual([]);
  });
});

describe('R4 — React declaration scope (dependencies.md §7)', () => {
  it('fails react/react-dom declared in a non-editor package (the R4 repro)', () => {
    const root = makeRoot();
    addPkg(root, 'three-adapter', {
      dependencies: { react: '19.3.0', 'react-dom': '19.3.0' },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'react-declared-outside-editor')).toBe(true);
    expect(vs[0].file).toBe('packages/three-adapter/package.json');
  });

  it('fails the React type packages declared outside editor', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      devDependencies: { '@types/react': '19.3.0', '@types/react-dom': '19.3.0' },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.rule === 'react-declared-outside-editor')).toBe(true);
  });

  it('allows react + type packages declared in editor (dependencies and devDependencies)', () => {
    const root = makeRoot();
    addPkg(root, 'editor', {
      dependencies: { react: '19.3.0', 'react-dom': '19.3.0' },
      devDependencies: {
        '@types/react': '19.3.0',
        '@types/react-dom': '19.3.0',
        '@types/three': '0.186.0',
      },
    });
    expect(checkWorkspace(root).violations).toEqual([]);
  });

  it('fails react declared in the root manifest (R4: declarations, not merely source use)', () => {
    const root = makeRoot();
    const rootPkg = {
      name: 'thirdlight',
      version: '0.0.0',
      private: true,
      devDependencies: { typescript: '5.9.3', react: '19.3.0' },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(rootPkg, null, 2));
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('react-declared-outside-editor');
    expect(vs[0].file).toBe('package.json');
  });

  it('fails a web framework declared in the root manifest', () => {
    const root = makeRoot();
    const rootPkg = {
      name: 'thirdlight',
      version: '0.0.0',
      private: true,
      dependencies: { express: '4.19.2' },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(rootPkg, null, 2));
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('forbidden-framework');
    expect(vs[0].file).toBe('package.json');
  });
});

describe('R5 — package-local test files (narrow vitest policy)', () => {
  it('allows vitest imports in designated package test files (the R5 repro)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      files: {
        'src/index.ts': 'export const ok = true;\n',
        'src/index.test.ts':
          "import { test, expect } from 'vitest';\n" +
          "import { ok } from './index';\n" +
          "test('ok', () => { expect(ok).toBe(true); });\n",
      },
    });
    expect(checkWorkspace(root).violations).toEqual([]);
  });

  it('allows vitest subpath imports in .spec.tsx test files', () => {
    const root = makeRoot();
    addPkg(root, 'runtime', {
      files: {
        'src/step.spec.tsx': "import { defineConfig } from 'vitest/config';\nexport const x = defineConfig;\n",
      },
    });
    expect(checkWorkspace(root).violations).toEqual([]);
  });

  it('forbids vitest in production files (production imports of test helpers fail)', () => {
    const root = makeRoot();
    addPkg(root, 'project-model', {
      files: {
        'src/index.ts': "import { expect } from 'vitest';\nexport const x = expect;\n",
      },
    });
    const v = checkWorkspace(root).violations;
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('forbidden-external');
  });

  it('keeps the cross-package edge rules for test files (tests are not exempt)', () => {
    const root = makeRoot();
    addPkg(root, 'commands');
    addPkg(root, 'runtime', {
      files: {
        'src/step.test.ts':
          "import { test } from 'vitest';\n" +
          "import { apply } from '@thirdlight/commands';\n" +
          "test('x', () => { apply(); });\n",
      },
    });
    const vs = checkWorkspace(root).violations;
    expect(vs).toHaveLength(1);
    expect(vs[0].rule).toBe('forbidden-edge');
    expect(vs[0].line).toBe(2);
  });
});

describe('specifier extraction (the three normative forms)', () => {
  it('extracts import forms with line numbers', () => {
    const src =
      "import a from 'one';\n" +
      "import { b, c } from 'two';\n" +
      "import * as d from 'three';\n" +
      "import e, { f } from 'four';\n" +
      "import 'five';\n" +
      "import type { T } from 'six';\n" +
      "import type g from 'seven';\n" +
      "import {\n  h,\n  i,\n} from 'multi';\n";
    const specs = extractSpecifiers(src);
    expect(specs.map((s) => s.spec)).toEqual([
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'multi',
    ]);
    expect(specs[0].line).toBe(1);
    expect(specs[4].line).toBe(5);
    expect(specs[7].line).toBe(8);
  });

  it('extracts export-from and dynamic import() forms', () => {
    const src =
      "export * from 'star';\n" +
      "export { a } from 'named';\n" +
      "export type { T } from 'typed';\n" +
      "const p = import('dyn');\n" +
      "const q = import('dyn2');\n";
    const specs = extractSpecifiers(src);
    expect(specs.map((s) => s.spec)).toEqual(['star', 'named', 'typed', 'dyn', 'dyn2']);
    expect(specs.every((s, i) => s.line === i + 1)).toBe(true);
  });

  it('does not match import.meta, require(), or plain prose', () => {
    const src =
      "const url = import.meta.url;\n" +
      "const r = require('old-style');\n" +
      "const s = 'use import from carefully';\n";
    expect(extractSpecifiers(src)).toEqual([]);
  });
});