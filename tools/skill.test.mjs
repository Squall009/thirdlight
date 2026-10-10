/**
 * The agent skill the engine ships (`skills/thirdlight/`) and how it reaches a
 * game folder:
 *
 * - its stamp is this engine's version, so it cannot drift from the identity
 *   `tools/project.mjs` pins projects to;
 * - it says how to work and lists no ops or fields (the running engine's
 *   `tl_docs` answers what exists), and every `tl_docs` topic it names
 *   resolves in this build's manual;
 * - `project.mjs skill` installs and updates it, refuses to overwrite a local
 *   edit without --force, and `check` warns about a missing, edited or older
 *   copy;
 * - creating a folder project installs it, through the backend (the editor's
 *   path) and through `project.mjs create`.
 *
 * Everything runs on scratch folders on the real filesystem; the tool runs as
 * the user runs it, in its own process.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MUTATION_OPS } from '../packages/commands/src/validate-request';
import { loadManual } from '../packages/backend/src/docs';
import { SKILL_INSTALL_DIR, SKILL_RECORD, SKILL_SOURCE_DIR, engineSkill, skillStamp } from '../packages/backend/src/skill-install.mjs';
import { api, startBackend } from '../packages/backend/src/test-helpers';
import { engineIdentity } from './project.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const TOOL = join(ROOT, 'tools', 'project.mjs');
const SKILL_DIR = join(ROOT, SKILL_SOURCE_DIR);
const SKILL_FILES = ['SKILL.md', 'traps.md'];

/** Ops the skill may name: the workflow steps it describes, never a catalogue. */
const ALLOWED_OPS = new Set(['createEntities', 'publishBehavior', 'acknowledgeBehaviorTrust']);
/** A backticked page or section of the manual, or a reference topic. */
const PAGE_TOPIC = /^(?:(?:getting-started|concepts|guides|features|reference)\/[\w-]+|deployment)(?:#[\w-]+)?$/;
const REF_TOPIC = /^(?:op|component|ctx|content|node|limit|tool|type|script-type|graph)\.[\w.-]+$/;

const text = (name) => readFileSync(join(SKILL_DIR, name), 'utf8');
const codeSpans = (t) => [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());

function run(args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: opts.cwd ?? ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

let scratch;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tl-skill-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const marker = (folder, version) =>
  writeFileSync(join(folder, 'thirdlight.json'), `${JSON.stringify({ thirdlightProject: 1, projectId: 'scratch', name: 'Scratch', projectDir: 'thirdlight', engine: { version } }, null, 2)}\n`);

describe('the skill the engine ships', () => {
  it('is stamped with this engine version, in Claude Code skill frontmatter', () => {
    const main = text('SKILL.md');
    expect(main.startsWith('---\nname: thirdlight\ndescription: ')).toBe(true);
    expect(skillStamp(main)).toBe(engineIdentity(ROOT).version);
    expect(engineSkill(ROOT).stamp).toBe(engineIdentity(ROOT).version);
    expect(main.split('\n').length).toBeLessThanOrEqual(300);
  });

  it('lists no ops or fields: only a few workflow ops, no tables, no field-definition lists', () => {
    const ops = new Set(MUTATION_OPS);
    for (const name of SKILL_FILES) {
      const t = text(name);
      const named = new Set();
      for (const span of codeSpans(t)) {
        const bare = span.startsWith('op.') ? span.slice(3) : span;
        if (ops.has(bare)) named.add(bare);
      }
      // Camel-case op names in prose count too ("undo" and "redo" are plain words).
      for (const w of t.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []) if (ops.has(w)) named.add(w);
      expect([...named].filter((op) => !ALLOWED_OPS.has(op)), name).toEqual([]);
      expect(t.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l)), `${name} has a table`).toEqual([]);
      expect(t.split('\n').filter((l) => /^\s*[-*]\s+`[\w.]+`\s*[:(—]/.test(l)), `${name} has a field list`).toEqual([]);
    }
  });

  it('every tl_docs topic it names resolves in this build, and its own links exist', async () => {
    const manual = await loadManual([join(ROOT, 'docs')]);
    expect(manual).not.toBeNull();
    let checked = 0;
    for (const name of SKILL_FILES) {
      const t = text(name);
      for (const span of codeSpans(t)) {
        if (!PAGE_TOPIC.test(span) && !REF_TOPIC.test(span)) continue;
        const a = manual.lookup({ topic: span });
        expect(a.ok, `${name}: tl_docs topic "${span}"`).toBe(true);
        checked += 1;
      }
      for (const m of t.matchAll(/\]\(([^)#]+)\)/g)) expect(existsSync(join(SKILL_DIR, m[1])), `${name} links ${m[1]}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('project.mjs skill and check', () => {
  it('installs, leaves an unchanged copy alone, refuses a local edit until --force, and check warns', async () => {
    const game = join(scratch, 'game');
    mkdirSync(game);
    marker(game, engineIdentity(ROOT).version);
    const installed = join(game, SKILL_INSTALL_DIR);

    let r = await run(['check', game]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no agent skill');

    r = await run(['skill', game]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skill installed');
    for (const f of SKILL_FILES) expect(readFileSync(join(installed, f), 'utf8')).toBe(text(f));
    expect(JSON.parse(readFileSync(join(installed, SKILL_RECORD), 'utf8'))).toMatchObject({ stamp: engineIdentity(ROOT).version, digest: engineSkill(ROOT).digest });
    r = await run(['check', game]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('warning');

    r = await run(['skill', game]);
    expect(r.stdout).toContain('skill unchanged');

    // A local edit is detected, named, and never overwritten silently.
    writeFileSync(join(installed, 'traps.md'), `${text('traps.md')}\n- my own note\n`);
    r = await run(['check', game]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('edited locally (traps.md)');
    r = await run(['skill', game]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--force');
    expect(readFileSync(join(installed, 'traps.md'), 'utf8')).toContain('my own note');
    r = await run(['skill', game, '--force']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skill updated');
    expect(readFileSync(join(installed, 'traps.md'), 'utf8')).toBe(text('traps.md'));
  });

  it('warns about a copy an older engine installed, and updates it without --force', async () => {
    const game = join(scratch, 'older');
    const installed = join(game, SKILL_INSTALL_DIR);
    mkdirSync(installed, { recursive: true });
    marker(game, engineIdentity(ROOT).version);
    // What an older engine would have installed: its own SKILL.md, a file this one dropped, and a record of both.
    const oldMain = text('SKILL.md').replace(/thirdlight-engine: "[^"]+"/, 'thirdlight-engine: "0.0.1"');
    writeFileSync(join(installed, 'SKILL.md'), oldMain);
    writeFileSync(join(installed, 'retired.md'), 'gone in the newer skill\n');
    const { createHash } = await import('node:crypto');
    const sha = (s) => createHash('sha256').update(s).digest('hex');
    writeFileSync(join(installed, SKILL_RECORD), JSON.stringify({ skill: 'thirdlight', stamp: '0.0.1', digest: 'old', files: { 'SKILL.md': sha(oldMain), 'retired.md': sha('gone in the newer skill\n') } }));

    let r = await run(['check', game]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('installed for engine 0.0.1');
    expect(r.stderr).toContain(`stamped for engine 0.0.1, the project is pinned to ${engineIdentity(ROOT).version}`);

    r = await run(['skill', game]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('skill updated');
    expect(existsSync(join(installed, 'retired.md'))).toBe(false);
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(text('SKILL.md'));
    r = await run(['check', game]);
    expect(r.stderr).not.toContain('warning');
  });
});

describe('creating a folder project installs the skill', () => {
  it('through the backend (the editor and project.mjs create send this) and through project.mjs create', async () => {
    const tb = await startBackend({ engineRoot: ROOT });
    try {
      const viaApi = join(scratch, 'via-api');
      const res = await api(`${tb.authUrl}/api/v1/admin/projects`, { body: { projectId: 'via-api', name: 'Via API', template: 'starter', folder: viaApi }, token: tb.adminToken, origin: null });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ ok: true, skill: { action: 'installed', stamp: engineIdentity(ROOT).version } });
      expect(readFileSync(join(viaApi, SKILL_INSTALL_DIR, 'SKILL.md'), 'utf8')).toBe(text('SKILL.md'));

      const tokenFile = join(scratch, 'owner-token');
      writeFileSync(tokenFile, `${tb.adminToken}\n`);
      const viaTool = join(scratch, 'via-tool');
      const r = await run(['create', viaTool, '--id', 'via-tool', '--template', 'starter', '--origin', tb.authUrl, '--token-file', tokenFile]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('skill unchanged');
      expect(readFileSync(join(viaTool, SKILL_INSTALL_DIR, 'SKILL.md'), 'utf8')).toBe(text('SKILL.md'));
      const check = await run(['check', viaTool]);
      expect(check.status).toBe(0);
      expect(check.stderr).toBe('');
    } finally {
      await tb.teardown();
    }
  });
});
