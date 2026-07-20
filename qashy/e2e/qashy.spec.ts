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

test('chooses readable locale and currency options during onboarding', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();

  // `exact` matters: the open list's radiogroup is labelled "Choose language",
  // and the search box "Search base currency", so a substring match would pull
  // in the dialog alongside the field it belongs to.
  const localeField = page.getByLabel('Language', { exact: true });
  await expect(localeField.getByText('English')).toBeVisible();
  await localeField.click();
  await page.getByRole('radio', { name: /Hebrew/ }).click();
  const hebrewLocaleField = page.getByLabel('שפה', { exact: true });
  await expect(hebrewLocaleField.getByText('עברית')).toBeVisible();
  await expect(page.getByText('שפה ומטבע')).toBeVisible();

  const currencyField = page.getByLabel('מטבע בסיס', { exact: true });
  await currencyField.click();
  await page.getByLabel('חיפוש מטבע בסיס').fill('ILS');
  await page.getByRole('radio', { name: /שקל/ }).click();
  await expect(currencyField.getByText(/שקל/)).toBeVisible();

  await page.getByRole('button', { name: 'המשך' }).click();
  await page.getByLabel('יתרת פתיחה (ILS)').fill('1000');
  await page.getByRole('button', { name: 'המשך' }).click();
  await page.getByRole('button', { name: 'התחילו להשתמש ב־Qashy' }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByText('מבט רגוע יותר על הכספים שלכם.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'סקירה' })).toBeVisible();
});

test('applies an onboarding theme choice immediately', async ({ page }) => {
  await page.goto('/');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const heading = page.getByText('Make it yours');
  const lightColor = await heading.evaluate((element) => getComputedStyle(element).color);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect.poll(() => heading.evaluate((element) => getComputedStyle(element).color)).not.toBe(lightColor);
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

test('keeps Plan creation actions inside their empty sections', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByRole('link', { name: 'Plan' }).click();

  await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Goals' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New budget' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New goal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create a budget' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a goal' })).toBeVisible();
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

test('resets all local data and returns to onboarding', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByRole('link', { name: 'More' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset all data' }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText('Money, made calmer.')).toBeVisible();
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

test('registers the service worker and starts offline', async ({ page, context, browserName }) => {
  await page.goto('/');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('4173');
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  // Reloading an offline context aborts inside WebKit itself ("WebKit
  // encountered an internal error"), so the offline leg only runs on Chromium.
  // Registration and control above are still asserted on every browser.
  test.skip(browserName === 'webkit', 'Playwright/WebKit cannot reload an offline context.');
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Money, made calmer.')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
