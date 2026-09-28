import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMutation, createCommandState } from '@thirdlight/commands';
const ROOT = '/home/dadmin/projects/thirdlight';
const TEMPLATE_DIR = join(ROOT, 'fixtures/m4/templates/templates/platformer-starter');
const recipe = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'recipe/commands.json'), 'utf8')) as { templateId: string; commands: Array<{ op: string; args: unknown }> };
const baseDoc = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'base/scene.json'), 'utf8'));
const content = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };
let state = createCommandState(baseDoc as never, content as never);
const origin = { kind: 'admin' as const, clientId: 'probe' };
for (let i = 0; i < recipe.commands.length; i += 1) {
  const cmd = recipe.commands[i];
  const requestId = `req-${createHash('sha256').update(Buffer.from(`${recipe.templateId}@1#${i + 1}`, 'utf8')).digest('hex').slice(0, 32)}`;
  const request = { op: cmd.op, projectId: 'm470-probe', expectedRevision: state.scene.revision, requestId, origin, args: cmd.args } as never;
  const outcome = applyMutation(state, request);
  if (!outcome.ok) { console.error('FAILED', i + 1, cmd.op); process.exit(1); }
  state = (outcome as { state: typeof state }).state;
}
const c = state.content as { prefabs: unknown[]; settings: unknown; game: unknown; behaviors: unknown[] };
console.log('prefabs:', JSON.stringify(c.prefabs));
console.log('settings:', JSON.stringify(c.settings));
console.log('game:', JSON.stringify(c.game));
console.log('behaviors:', JSON.stringify(c.behaviors));
