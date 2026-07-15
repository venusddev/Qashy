import { expect, test } from '@playwright/test';

test('onboarding shell is responsive and branded', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Money, made calmer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('exposes an installable web manifest', async ({ page }) => {
  const response = await page.request.get('/manifest.json');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.short_name).toBe('Qashy');
  expect((await page.request.get(manifest.icons[0].src)).ok()).toBeTruthy();
});

test('completes onboarding and records an expense', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Opening balance (USD)').fill('1000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Start using Qashy' }).click();
  await expect(page.getByText('A quieter view of your finances.')).toBeVisible();

  await page.getByLabel('Add transaction').first().click();
  await page.getByLabel('Amount (USD)').fill('12.50');
  await page.getByLabel('Title').fill('Coffee');
  await page.getByRole('radio', { name: 'Dining' }).click();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page).toHaveURL(/\/overview$/, { timeout: 15_000 });
  await expect(page.getByText('Coffee')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Coffee')).toBeVisible();
  await page.getByRole('link', { name: /Transactions/ }).click();
  await page.getByRole('button', { name: /Coffee/ }).click({ delay: 650 });
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('radio', { name: 'Groceries' }).click();
  await expect(page.getByText(/Groceries · Everyday/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Groceries · Everyday/)).toBeVisible();
});

test('registers the service worker and starts offline', async ({ page, context }) => {
  await page.goto('/');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('4173');
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Money, made calmer.')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
