/**
 * @thirdlight/exporter tests (packet 12).
 *
 * The pipeline is exercised with an INJECTED fake workspace service and an
 * INJECTED in-memory `ExportFs` (the exporter's own edge set has no Node
 * builtins — the real-fs + real-service + real-HTTP end-to-end lives in the
 * backend package's export.test.ts, where `node:fs` is allowed). The esbuild
 * build is REAL: the actual `export-bootstrap.ts` entry is bundled against
 * the real installed `three@0.186.0`, so the graph check and the §5.4 scan
 * (incl. the §5.4.1 recorded-exception counts) run against genuine bytes.
 */
import { describe, it, expect } from 'vitest';

import { nodeSpecifierOffsets, scanExportFiles, THREE_RECORD } from './scan';
import { canonicalDocument, canonicalJson } from './canonical';

// ---- fixtures --------------------------------------------------------------------

// ---- in-memory ExportFs -----------------------------------------------------------

// ---- context factory ---------------------------------------------------------------

function count(s: string, needle: string): number {
  let n = 0;
  let i = s.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = s.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---- tests --------------------------------------------------------------------------

describe('forbidden-content scan (export.md §5.4/§5.4.1)', () => {
  const patterns = { authoringOrigin: 'http://127.0.0.1:8501', previewOrigin: 'http://127.0.0.1:8502', tokenValues: ['tok-abc'] };

  function referenceBytes(): Uint8Array {
    // A synthetic "reference three" with exactly the recorded counts.
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    return new TextEncoder().encode(parts.join('\n'));
  }

  function bundleBytes(extra = ''): Uint8Array {
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    parts.push('fetch("./snapshot.json")');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    parts.push(extra);
    return new TextEncoder().encode(parts.join('\n'));
  }

  const identity = { version: THREE_RECORD.version, integrity: THREE_RECORD.integrity };

  it('passes with the exact recorded counts when the binding holds', () => {
    const report = scanExportFiles(
      [
        { name: 'index.html', bytes: new TextEncoder().encode('<html><script src="./js/main.js"></script></html>') },
        { name: 'js/main.js', bytes: bundleBytes() },
        { name: 'snapshot.json', bytes: new TextEncoder().encode('{"projectId":"demo-0001"}\n') },
        { name: 'meta.json', bytes: new TextEncoder().encode('{"type":"thirdlight-export"}\n') },
      ],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(report.binding.identityOk).toBe(true);
    expect(report.binding.referenceOk).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.scanHits).toBe(0);
  });

  it('fails when an EXTRA fetch( appears in the bundle (count deviation)', () => {
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes('fetch("https://evil")') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(report.ok).toBe(false);
    expect(report.scanHits).toBeGreaterThanOrEqual(1);
    // The deviation is reported for BOTH the extra fetch( and the extra
    // https:// (the injected literal); assert the fetch( hit is among them.
    expect(report.hits.some((h) => h.pattern === 'fetch(')).toBe(true);
    expect(report.hits.some((h) => h.context.includes('fetch('))).toBe(true);
  });

  it('fails when the three identity is wrong (the exception table is void)', () => {
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes() }],
      patterns,
      'js/main.js',
      { version: '0.186.1', integrity: THREE_RECORD.integrity },
      referenceBytes(),
    );
    expect(report.binding.identityOk).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('fails when the reference build deviates from the recorded table (fails closed)', () => {
    const badRef = new TextEncoder().encode('fetch(\nfetch(\nfetch(\nfetch('); // 4 ≠ 3
    const report = scanExportFiles(
      [{ name: 'js/main.js', bytes: bundleBytes() }],
      patterns,
      'js/main.js',
      identity,
      badRef,
    );
    expect(report.binding.referenceOk).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('fails when a token value or the authoring origin appears in any file', () => {
    const r1 = scanExportFiles(
      [{ name: 'meta.json', bytes: new TextEncoder().encode('{"x":"tok-abc"}') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(r1.ok).toBe(false);
    expect(r1.hits[0]?.pattern).toBe('tok-abc');
    const r2 = scanExportFiles(
      [{ name: 'index.html', bytes: new TextEncoder().encode('<!-- http://127.0.0.1:8501 -->') }],
      patterns,
      'js/main.js',
      identity,
      referenceBytes(),
    );
    expect(r2.ok).toBe(false);
  });

  it('fails on node: / __dirname / WebSocket / /api/v1/ / file:// anywhere', () => {
    for (const bad of ["import 'node:fs'", '__dirname', 'new WebSocket', '/api/v1/sessions', 'file:///x']) {
      const report = scanExportFiles(
        [{ name: 'index.html', bytes: new TextEncoder().encode(`<i>${bad}</i>`) }],
        patterns,
        'js/main.js',
        identity,
        referenceBytes(),
      );
      expect(report.ok, bad).toBe(false);
    }
  });
});

describe('pattern e: Node built-in module specifiers (phase 17.1)', () => {
  const patterns = { authoringOrigin: 'http://127.0.0.1:8501', previewOrigin: 'http://127.0.0.1:8502', tokenValues: [] };
  const identity = { version: THREE_RECORD.version, integrity: THREE_RECORD.integrity };
  const reference = (): Uint8Array => {
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    return new TextEncoder().encode(parts.join('\n'));
  };
  const bundle = (extra: string): Uint8Array => {
    const parts: string[] = [];
    for (let i = 0; i < THREE_RECORD.fetch; i += 1) parts.push('fetch(');
    parts.push('fetch("./snapshot.json")');
    for (let i = 0; i < THREE_RECORD.processDot; i += 1) parts.push('process.env.X');
    for (let i = 0; i < THREE_RECORD.http; i += 1) parts.push('http://x');
    for (let i = 0; i < THREE_RECORD.https; i += 1) parts.push('https://x');
    for (let i = 0; i < THREE_RECORD.xhr; i += 1) parts.push('XMLHttpRequest');
    parts.push(extra);
    return new TextEncoder().encode(parts.join('\n'));
  };
  const scan = (extra: string) => scanExportFiles([{ name: 'js/main.js', bytes: bundle(extra) }], patterns, 'js/main.js', identity, reference());

  it('does not match object keys named node (three\'s node-material code, minified or not)', () => {
    // The six shapes the 17.0 spike found in three/webgpu, plus minified and JSON keys.
    const keys = [
      'const bufferData = { node: this };',
      'return { previousInstanceMatrix, node: createInstanceMatrixNode(mesh) };',
      '{ previousMatricesTexture, node: createBatchingMatrixNode(batch) }',
      'node: buffer(previousBoneMatrices, "mat4", count)',
      'node: getBoneTextureMatrices(skeleton)',
      'var a={node:b,type:c};',
      '{"node":1,"nodes":[]}',
      'fnode: 1, xnode:2',
    ];
    const r = scan(keys.join('\n'));
    expect(r.binding.referenceOk).toBe(true);
    expect(r.ok).toBe(true);
    expect(nodeSpecifierOffsets(keys.join('\n'))).toEqual([]);
  });

  it('matches every real Node built-in module reference', () => {
    for (const bad of [
      "import 'node:fs';",
      'import fs from "node:fs";',
      "import { readFile } from 'node:fs/promises';",
      'export * from "node:path";',
      'const fs = require("node:fs");',
      "const os = require( 'node:os' );",
      'const m = await import(`node:crypto`);',
      "import('node:child_process')",
    ]) {
      const r = scan(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'node:'), bad).toBe(true);
    }
  });

  it('fails the reference binding when the reference build itself has a node: specifier', () => {
    const bad = new TextEncoder().encode(new TextDecoder().decode(reference()) + '\nrequire("node:fs")');
    const r = scanExportFiles([{ name: 'js/main.js', bytes: bundle('') }], patterns, 'js/main.js', identity, bad);
    expect(r.binding.referenceOk).toBe(false);
    expect(r.binding.reason).toContain("'node:' module specifiers");
  });
});

describe('canonical serialization (export.md §3, project-model §12.2 style)', () => {
  it('emits fixed field order, 2-space indent, LF, one trailing newline, no BOM', () => {
    const doc = { a: 1, b: ['x', 'y'], c: { d: true, e: null }, f: 's' };
    const text = canonicalJson(doc, 0) + '\n';
    expect(text).toBe('{\n  "a": 1,\n  "b": [\n    "x",\n    "y"\n  ],\n  "c": {\n    "d": true,\n    "e": null\n  },\n  "f": "s"\n}\n');
    const bytes = canonicalDocument(doc);
    expect(bytes[0]).not.toBe(0xef);
    expect(new TextDecoder().decode(bytes).endsWith('}\n')).toBe(true);
  });
  it('escapes strings per JSON semantics', () => {
    expect(canonicalJson({ s: 'a"b\nc' }, 0)).toBe('{\n  "s": "a\\"b\\nc"\n}');
  });
});