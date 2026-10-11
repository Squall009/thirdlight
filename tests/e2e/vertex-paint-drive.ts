/**
 * Driving the editor's Scene view with a tool armed: world points to canvas
 * pixels through the view-projection the armed tool publishes, selecting and
 * framing an object, zooming until points are in view, and the Vertex paint
 * window's settings, strokes and their state.
 */
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
export type PaintState = { armed: boolean; stroking: boolean; strokes: number; last: { entityId: string; target: string; dabs: number; previewMs: number; latencyMs: number | null; commandMs: number | null; ok: boolean | null; code?: string } | null; watch: { id: string; frames: number; gaps: number } | null; view: number | null };
export async function paintState(page: Page): Promise<PaintState | null> {
  return JSON.parse((await view(page).getAttribute('data-vertex-paint')) ?? 'null') as PaintState | null;
}
export async function setPaint(page: Page, values: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    const field = page.getByLabel(`vertex paint ${k}`, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption(v);
    else {
      await field.fill(v);
      await field.blur();
    }
  }
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
  // In the view and clear of the tool window floating over it.
  const win = await page.getByLabel('vertex paint tool').boundingBox();
  const covered = (p: { x: number; y: number }): boolean => win !== null && box.x + p.x >= win.x - 8 && box.y + p.y >= win.y - 40;
  for (const p of [a, b]) expect(p.x > 4 && p.x < box.width - 4 && p.y > 4 && p.y < box.height - 4 && !covered(p), `paint point in view ${JSON.stringify(p)}`).toBe(true);
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
