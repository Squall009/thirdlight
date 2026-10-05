#!/usr/bin/env node
/**
 * Mark the placed models of a COPY of a game project static, so static
 * batching can be measured on a game whose scenes do not set the flag yet.
 *
 *   node tools/perf/mark-static.mjs <copied project folder>
 *
 * Writes the copy's `game/scenes/*.scene.json` in place: never point it at a
 * game's own folder (tools/perf/games.sh runs it on its copy with
 * TL_GAME_STATIC=1). An entity is marked when it shows a model and nothing
 * moves it as far as the files say: no animator, model animation, behavior,
 * controller or effect on it or an ancestor, and neither its id nor an
 * ancestor's appears in any other file of the game (timelines, scripts,
 * dialogue and UI address objects by id).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const folder = process.argv[2];
if (folder === undefined) {
  console.error('usage: mark-static.mjs <copied project folder>');
  process.exit(2);
}
const game = join(folder, 'game');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(json|ts|js)$/.test(name)) files.push(p);
  }
};
walk(game);
const scenes = files.filter((f) => f.endsWith('.scene.json'));
const others = files.filter((f) => !f.endsWith('.scene.json')).map((f) => readFileSync(f, 'utf8')).join('\n');
const MOVERS = ['animator', 'modelAnimation', 'behavior', 'controller', 'effect'];
let marked = 0;
for (const file of scenes) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const entities = doc.scene?.entities ?? doc.entities ?? [];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const moves = (e) => {
    for (let x = e, depth = 0; x !== undefined && depth < 64; x = byId.get(x.parentId), depth += 1) {
      if (MOVERS.some((k) => x.components?.[k] !== undefined) || others.includes(`"${x.id}"`) || others.includes(`'${x.id}'`)) return true;
    }
    return false;
  };
  let here = 0;
  for (const e of entities) {
    if (e.components?.model === undefined || e.static === true || moves(e)) continue;
    e.static = true;
    here += 1;
  }
  if (here > 0) writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`mark-static: ${file}: ${here} of ${entities.filter((e) => e.components?.model !== undefined).length} models marked static`);
  marked += here;
}
console.log(`mark-static: ${marked} entities marked`);
