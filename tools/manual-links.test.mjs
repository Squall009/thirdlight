/**
 * The manual's links hold: every relative link in docs/manual lands on an
 * existing file and, when it names one, on an existing anchor (an explicit
 * `<a id>` or a heading's GitHub-style slug), and every hand-written page is
 * reached from another page. Links into docs/deployment.md are checked the
 * same way, so moving a section out of it breaks this test until the links
 * follow. Links inside code blocks and inline code are not links.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { pageSections } from '../packages/backend/src/docs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MANUAL = join(ROOT, 'docs', 'manual');

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** The text without fenced code blocks and inline code spans. */
function prose(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
}

const anchorCache = new Map();
/** A page's anchors as the backend's documentation lookup reads them (tl_docs answers every link this test passes). */
function anchorsOf(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, new Set(pageSections(readFileSync(file, 'utf8')).ids.keys()));
  return anchorCache.get(file);
}

/** Every relative link of a page: [text](target) outside code, http(s) and mailto left out. */
function links(text) {
  return [...prose(text).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t));
}

const pages = markdownFiles(MANUAL);

describe('manual links (docs/manual)', () => {
  it('has pages to check', () => {
    expect(pages.length).toBeGreaterThan(10);
    expect(pages).toContain(join(MANUAL, 'index.md'));
  });

  it('every relative link lands on an existing file and anchor', () => {
    const broken = [];
    for (const page of pages) {
      for (const target of links(readFileSync(page, 'utf8'))) {
        const [path, anchor] = target.split('#');
        const file = path === '' ? page : resolve(dirname(page), decodeURIComponent(path));
        const where = `${relative(ROOT, page)} → ${target}`;
        if (!existsSync(file)) {
          broken.push(`${where} (no such file)`);
          continue;
        }
        if (anchor !== undefined && anchor !== '' && file.endsWith('.md') && !anchorsOf(file).has(decodeURIComponent(anchor))) broken.push(`${where} (no such anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every hand-written page is linked from another page', () => {
    const linked = new Set();
    for (const page of pages) {
      for (const target of links(readFileSync(page, 'utf8'))) {
        const path = target.split('#')[0];
        if (path !== '') linked.add(resolve(dirname(page), decodeURIComponent(path)));
      }
    }
    const generated = join(MANUAL, 'reference');
    const orphans = pages.filter((p) => p !== join(MANUAL, 'index.md') && !p.startsWith(generated + '/') && !linked.has(p)).map((p) => relative(ROOT, p));
    expect(orphans).toEqual([]);
  });

  it('computes heading anchors as GitHub does', () => {
    expect([...pageSections("## Projects in a game's own folder\n## MCP (coding harness)\n## A\n## A").ids.keys()]).toEqual(['projects-in-a-games-own-folder', 'mcp-coding-harness', 'a', 'a-1']);
  });
});
