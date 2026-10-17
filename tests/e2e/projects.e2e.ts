/**
 * The screens before a project is open: the owner token is entered once,
 * the picker lists the backend's projects, and a new project is created
 * from a template (or empty) and opened in the editor; the 3D starter plays
 * with a sky and ground.
 */
import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { screen } from './rooms-drawing';
import { enterEditMode, leaveEditMode } from './ui';
import { viewCamera } from './view-match';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('picker-0001');
});
test.afterEach(async () => {
  await be.stop();
});

const status = (page: import('@playwright/test').Page) => page.locator('.tl-statusbar');
const rows = (page: import('@playwright/test').Page) => page.locator('.tl-hierarchy__list li.tl-row');

test('a wrong token is rejected and asked for again; token once, then pick a project or create one from a template', async ({ page }) => {
  // A wrong token is rejected by the picker and asked for again.
  await page.goto(`${be.origin}/#token=not-the-owner-token-at-all`);
  await expect(page.getByText('rejected the access token')).toBeVisible();
  await expect(page.getByLabel('Access token')).toBeVisible();

  // No (accepted) token yet: the token form, not the picker.
  await page.goto(`${be.origin}/`);
  await expect(page.getByLabel('Access token')).toBeVisible();
  await page.getByLabel('Access token').fill(be.token);
  await page.getByRole('button', { name: 'Open' }).click();

  // The picker lists the existing project.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  const existing = page.locator('.tl-projects__row').filter({ hasText: 'picker-0001' });
  await expect(existing).toHaveCount(1);
  await expect(existing).toContainText('E2E Project');

  // Create a project from the starter template and land in the editor.
  await page.getByLabel('Project id').fill('starter-copy');
  await page.getByLabel('Name').fill('Starter copy');
  await page.getByRole('radiogroup', { name: 'Template' }).locator('label', { hasText: '2D starter' }).click();
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'Player' })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('project')).toBe('starter-copy');

  // Back to the picker from the toolbar: both projects, then an empty one.
  await page.getByTitle('All projects').click();
  await expect(page.locator('.tl-projects__row')).toHaveCount(2);
  await expect(page.locator('.tl-projects__row').filter({ hasText: 'Starter copy' })).toHaveCount(1);
  await page.getByLabel('Project id').fill('blank');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'Player' })).toHaveCount(0);
  await expect(rows(page)).not.toHaveCount(0);

  // A duplicate id is refused with a message; the picker stays.
  await page.getByTitle('All projects').click();
  await page.getByLabel('Project id').fill('blank');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.getByText('already exists')).toBeVisible();

  // Opening an existing project from the list works, and the stored token
  // is reused (no form).
  await page.locator('.tl-projects__open').filter({ hasText: 'picker-0001' }).click();
  await expect(status(page)).toContainText('connected');

  // The 3D starter beside the 2D one, each with its picture and line: a new project from it is a 3D level —
  // the Basic Kit's block ground, a terrain, a follow camera — and Play shows the sky above the horizon and
  // the ground below it (never black).
  await page.getByTitle('All projects').click();
  const cards = page.getByRole('radiogroup', { name: 'Template' }).locator('label');
  for (const name of ['2D starter', '3D starter']) {
    const card = cards.filter({ hasText: name });
    await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await expect(card).toContainText('No game rules.');
  }
  await page.getByLabel('Project id').fill('world-3d');
  await cards.filter({ hasText: '3D starter' }).click();
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected', { timeout: 30_000 });
  for (const name of ['Player', 'Ground blocks', 'Terrain', 'Follow camera', 'Sun']) await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  // The mean colour of a band of the picture (fractions of its height).
  const band = (img: Image, from: number, to: number): [number, number, number] => {
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.floor(img.height * from); y < Math.floor(img.height * to); y += 4) {
      for (let x = 0; x < img.width; x += 4) {
        const px = img.pixel(x, y);
        for (let k = 0; k < 3; k++) sum[k]! += px[k]!;
        n++;
      }
    }
    return sum.map((v) => v / n) as [number, number, number];
  };
  let sky: [number, number, number] = [0, 0, 0];
  let ground: [number, number, number] = [0, 0, 0];
  await expect
    .poll(async () => {
      const img = decodePng(await frame.screenshot());
      sky = band(img, 0.02, 0.12);
      ground = band(img, 0.8, 0.95);
      // Sky: bright and blue. Ground: lit (not black) and not the sky's colour.
      return sky[2] > 120 && sky[2] > sky[0] + 15 && ground[0] + ground[1] + ground[2] > 90 && Math.abs(ground[2] - sky[2]) > 20;
    }, { timeout: 45_000, intervals: [1000] })
    .toBe(true)
    .catch((e: unknown) => {
      console.log(`[projects] 3D starter play: sky ${sky.map(Math.round).join(',')}, ground ${ground.map(Math.round).join(',')}`);
      throw e;
    });
  console.log(`[projects] 3D starter play: sky ${sky.map(Math.round).join(',')}, ground ${ground.map(Math.round).join(',')}`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // The block editor on the starter's ground opens on a usable view: the first view is a few metres up, inside the
  // layer's box, so entering frames the layer from outside and above, looking down at it. A view that shows it so is
  // kept when the editor opens again.
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  await rows(page).filter({ hasText: 'Ground blocks' }).click();
  await enterEditMode(page, 'Edit blocks');
  const camera = async (): Promise<number[]> => (await viewCamera(page)).position;
  await expect.poll(async () => {
    const [x, y, z] = await camera();
    const mid = await screen(page, [0, 2, 0]);
    const v = (await page.locator('canvas.tl-viewport').boundingBox())!;
    return Math.max(Math.abs(x!), Math.abs(z!)) > 12 && y! > 5 && mid !== null && mid.x > v.x && mid.x < v.x + v.width && mid.y > v.y && mid.y < v.y + v.height;
  }, { message: 'entering the block editor frames the layer from outside, above it' }).toBe(true);
  await leaveEditMode(page);
  const kept = await camera();
  await enterEditMode(page, 'Edit blocks');
  await page.waitForTimeout(300);
  expect(await camera()).toEqual(kept);
  await leaveEditMode(page);
});
