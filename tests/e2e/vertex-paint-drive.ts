/**
 * Driving the editor's Scene view with a tool armed: world points to canvas
 * pixels through the view-projection the armed tool publishes, selecting and
 * framing an object, zooming until points are in view, and the vertex paint
 * editor — entered from the Inspector, its palette, brush, tools and channel
 * view, strokes and their state.
 */
import { armTile, inspector } from './ui';
import { expect, type Locator, type Page } from './pw';

export const view = (page: Page): Locator => page.locator('canvas.tl-viewport');
export type Projector = (p: readonly [number, number, number]) => { x: number; y: number } | null;
/** World → canvas pixel from the Scene view's published view-projection (the brush publishes it while on). */
export async function sceneProjector(page: Page): Promise<Projector> {
  const m = JSON.parse((await view(page).getAttribute('data-view-proj'))!) as number[];
  const box = (await view(page).boundingBox())!;
  return ([x, y, z]) => {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (w <= 0) return null;
    return { x: (((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w + 1) / 2) * box.width, y: ((1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) / 2) * box.height };
  };
}
export async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}
/** Frame `id` (F). */
export async function frame(page: Page, id: string): Promise<void> {
  await select(page, id);
  const box = (await view(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
}
/** With the brush on (the view's projection published): zoom out until the points are well inside the view. */
export async function fit(page: Page, points: readonly (readonly [number, number, number])[]): Promise<void> {
  const box = (await view(page).boundingBox())!;
  const inside = async (): Promise<boolean> => {
    const project = await sceneProjector(page);
    return points.every((p) => {
      const s = project(p);
      return s !== null && s.x > box.width * 0.15 && s.x < box.width * 0.85 && s.y > box.height * 0.15 && s.y < box.height * 0.85;
    });
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 40 && !(await inside()); i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(80);
  }
  expect(await inside(), 'the stroke is in view').toBe(true);
  await page.mouse.move(0, 0);
}
export type PaintState = { armed: boolean; navigate: boolean; entityId: string | null; channel: number | null; cursor: 'paint' | 'erase' | 'off' | null; stroking: boolean; strokes: number; last: { entityId: string; target: string; dabs: number; previewMs: number; latencyMs: number | null; commandMs: number | null; ok: boolean | null; code?: string } | null; watch: { id: string; frames: number; gaps: number } | null; view: number | null };
export async function paintState(page: Page): Promise<PaintState | null> {
  return JSON.parse((await view(page).getAttribute('data-vertex-paint')) ?? 'null') as PaintState | null;
}
/** The vertex paint editor's frame. */
export const paintEditor = (page: Page): Locator => page.locator('.tl-editmode[data-edit-mode="vertex-paint"]');
/**
 * Open the vertex paint editor on an object (selected, then the Inspector's Paint vertices). It opens with no tool
 * (Navigate: the brush paints nothing, a drag orbits); the last tool is armed then, when the material reads paint.
 */
export async function enterPaint(page: Page, id: string): Promise<void> {
  await select(page, id);
  await inspector(page).getByRole('button', { name: 'Paint vertices', exact: true }).click();
  await expect(paintEditor(page)).toHaveAttribute('data-entity-id', id);
  await expect.poll(async () => (await paintState(page))?.entityId ?? null).toBe(id);
  expect((await paintState(page))?.navigate, 'it opens with no tool').toBe(true);
  const grid = paintEditor(page).getByRole('toolbar', { name: 'vertex paint tool' });
  const last = grid.locator('.tl-tool.is-last');
  if (!(await last.isEnabled())) return;
  // The last tile by its name (once armed it is no longer marked last).
  await armTile(grid.getByRole('button', { name: (await last.locator('span').textContent())!, exact: true }));
  await expect.poll(async () => (await paintState(page))?.navigate).toBe(false);
}
/** Done: the editor closes, the brush is disarmed. */
export async function leavePaint(page: Page): Promise<void> {
  await paintEditor(page).getByRole('button', { name: /^done/i }).click();
  await expect(paintEditor(page)).toHaveCount(0);
  await expect.poll(async () => (await paintState(page))?.armed ?? false).toBe(false);
}
/** Pick a palette tile by its place (0: the first) and wait for the brush to paint its channel. */
export async function pickTile(page: Page, index: number, channel: number): Promise<void> {
  await paintEditor(page).getByRole('radiogroup', { name: 'paint layers' }).locator(`[data-layer="${index}"]`).click();
  await expect.poll(async () => (await paintState(page))?.channel ?? null).toBe(channel);
}
/** The shared brush's fields: size (m across), strength (%), the falloff by its name. */
export async function setPaint(page: Page, values: { size?: string; strength?: string; falloff?: string }): Promise<void> {
  const col = paintEditor(page);
  for (const k of ['size', 'strength'] as const) {
    const v = values[k];
    if (v === undefined) continue;
    const field = col.getByLabel(`brush ${k}`, { exact: true });
    await field.fill(v);
    await field.press('Enter');
  }
  if (values.falloff !== undefined) await col.getByRole('radiogroup', { name: 'brush falloff' }).getByRole('radio', { name: values.falloff, exact: true }).click();
}
/** Paint or erase (the tool grid). */
export async function paintTool(page: Page, tool: 'Paint' | 'Erase'): Promise<void> {
  await armTile(paintEditor(page).getByRole('toolbar', { name: 'vertex paint tool' }).getByRole('button', { name: tool, exact: true }));
  await expect.poll(async () => (await paintState(page))?.navigate ?? true).toBe(false);
}
/** The channel view's chip by its label ("Final", a layer's name, "Wetness"). */
export async function channelView(page: Page, label: string): Promise<void> {
  await paintEditor(page).getByRole('radiogroup', { name: 'channel view' }).getByRole('radio', { name: label, exact: true }).click();
}
/**
 * A paint stroke across world points (the pointer down at `from`, moved to `to`); `during` runs with the button
 * still down (the preview's picture), then the release.
 */
export async function paintDrag(page: Page, from: readonly [number, number, number], to: readonly [number, number, number], during?: () => Promise<void>): Promise<void> {
  const project = await sceneProjector(page);
  const box = (await view(page).boundingBox())!;
  const a = project(from)!;
  const b = project(to)!;
  for (const p of [a, b]) expect(p.x > 4 && p.x < box.width - 4 && p.y > 40 && p.y < box.height - 4, `paint point in view ${JSON.stringify(p)}`).toBe(true);
  await page.mouse.move(box.x + a.x, box.y + a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + a.x + ((b.x - a.x) * i) / 12, box.y + a.y + ((b.y - a.y) * i) / 12);
  if (during !== undefined) await during();
  await page.mouse.up();
}
/** The stroke answered and its stored paint drawn in place of the preview. */
export async function strokeDone(page: Page, strokes: number): Promise<NonNullable<PaintState['last']>> {
  let st: PaintState | null = null;
  await expect.poll(async () => {
    st = await paintState(page);
    return st !== null && st.strokes === strokes && st.last?.ok === true && st.last.latencyMs !== null;
  }, { timeout: 20_000, message: `the stroke stored and drawn (${JSON.stringify(await paintState(page))})` }).toBe(true);
  return (st as unknown as PaintState).last!;
}
