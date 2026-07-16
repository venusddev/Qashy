import { expect, test, type Page } from '@playwright/test';

async function completeOnboarding(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Opening balance (USD)').fill('1000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Start using Qashy' }).click();
  await expect(page).toHaveURL(/\/overview$/);
}

test('onboarding shell is responsive and branded', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Money, made calmer.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('guards onboarding and stale edit routes', async ({ page }) => {
  await page.goto('/overview');
  await expect(page).toHaveURL(/\/onboarding$/);
  await completeOnboarding(page);
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/overview$/);
  await page.goto('/transaction?id=missing');
  await expect(page).toHaveURL(/\/transactions$/);
});

test('exposes an installable web manifest', async ({ page }) => {
  const response = await page.request.get('/manifest.json');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.short_name).toBe('Qashy');
  expect((await page.request.get(manifest.icons[0].src)).ok()).toBeTruthy();
  expect((await page.request.get(manifest.icons[1].src)).ok()).toBeTruthy();
});

test('completes onboarding and records an expense', async ({ page }) => {
  await completeOnboarding(page);
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
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: /Coffee/ }).click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Groceries' }).click();
  await expect(page.getByText(/Groceries · Everyday/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Groceries · Everyday/)).toBeVisible();
});

test('labels compact navigation and recovers a one-account transfer draft', async ({ page }) => {
  await completeOnboarding(page);
  await page.setViewportSize({ width: 900, height: 820 });
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const overviewLink = page.getByRole('link', { name: 'Overview' });
  await expect(overviewLink).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Transactions' })).toBeVisible();

  await page.getByLabel('Add transaction').first().click();
  await page.getByRole('radio', { name: 'Transfer' }).click();
  await expect(page.getByText('Transfers need two accounts')).toBeVisible();
  await page.getByRole('button', { name: 'Add another account' }).click();
  await page.getByLabel('Account name').fill('Savings');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/transaction/);
  await expect(page.getByRole('radiogroup', { name: 'To account' }).getByRole('radio', { name: /Savings · USD/ })).toBeVisible();
});

test('can leave an invalid custom accent by returning to the default source', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('button', { name: /Appearance/ }).click();
  await page.getByLabel('Custom accent').fill('#ZZ');
  await page.getByRole('radio', { name: /Qashy default|Material You wallpaper/ }).click();
  const save = page.getByRole('button', { name: 'Save appearance' });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
});

test('clears batch selection when the transaction search changes', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByLabel('Add transaction').first().click();
  await page.getByLabel('Amount (USD)').fill('12.50');
  await page.getByLabel('Title').fill('Coffee');
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByRole('link', { name: /Transactions/ }).click();
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: /Coffee/ }).click();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByLabel('Search transactions').fill('no match');
  await expect(page.getByText('0 selected')).toBeVisible();
  await page.getByLabel('Search transactions').fill('');
  await expect(page.getByRole('checkbox', { name: /Coffee/ })).not.toBeChecked();
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
