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
  await expect(page.locator('html')).toHaveAttribute('lang', 'he-IL');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByLabel('הוספת תנועה').first().click();
  await expect(page.getByRole('radiogroup', { name: 'סוג תנועה' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'מסעדות' })).toBeVisible();
  await page.getByLabel('סכום (ILS)').fill('10');
  await page.getByLabel('כותרת').fill('בדיקת נגישות');
  await page.getByRole('button', { name: 'הוספת תנועה' }).click();
  await expect(page.getByRole('button', { name: /הוצאה, כסף יצא.*בדיקת נגישות/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Expense, money out/ })).toHaveCount(0);

  await page.goto('/goal');
  await expect(page.getByLabel('שם היעד')).toHaveValue('קרן ליום גשום');
  await page.getByRole('button', { name: 'יצירת יעד' }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByText('יעד חיסכון')).toBeVisible();
  await expect(page.getByText('saving goal')).toHaveCount(0);

  await page.goto('/budget');
  await expect(page.getByLabel('שם התקציב')).toHaveValue('הוצאות יומיומיות');
  await page.getByRole('button', { name: 'יצירת תקציב' }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await expect(page.getByText(/ to /)).toHaveCount(0);

  await page.getByRole('link', { name: 'עוד' }).click();
  await page.getByRole('button', { name: 'מחזורית חדשה' }).click();
  await expect(page.getByText('רישום אוטומטי')).toBeVisible();
  await expect(page.getByText('כבוי כברירת מחדל. תנועות עתידיות ממתינות לבדיקה שלכם.')).toBeVisible();
  await expect(page.getByText('כל 1 חודש')).toBeVisible();
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

test('reconciles finance changes across open browser tabs', async ({ page, context }) => {
  await completeOnboarding(page);
  const secondPage = await context.newPage();
  await secondPage.goto('/transactions');
  await expect(secondPage.getByText('No transactions yet')).toBeVisible();

  await page.getByLabel('Add transaction').first().click();
  await page.getByLabel('Amount (USD)').fill('8');
  await page.getByLabel('Title').fill('Cross-tab update');
  await page.getByRole('button', { name: 'Add transaction' }).click();

  await secondPage.bringToFront();
  await expect(secondPage.getByText('Cross-tab update')).toBeVisible();
  await secondPage.close();
});

test('preserves a selected transaction type and lets an edit clear its category', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByLabel('Add transaction').first().click();
  await page.getByLabel('Amount (USD)').fill('12.50');
  await page.getByLabel('Title').fill('Category edit');
  await page.getByRole('radio', { name: 'Dining' }).click();
  await page.getByRole('radio', { name: 'Expense' }).click();
  await expect(page.getByRole('radio', { name: 'Dining' })).toBeChecked();
  await page.getByRole('button', { name: 'Add transaction' }).click();

  await page.getByRole('link', { name: /Transactions/ }).click();
  await page.getByRole('button', { name: /Category edit/ }).click();
  await page.getByRole('radio', { name: 'Expense' }).click();
  await expect(page.getByRole('radio', { name: 'Dining' })).toBeChecked();
  const uncategorized = page.getByRole('radio', { name: 'Uncategorized' });
  await uncategorized.click();
  await expect(uncategorized).toBeChecked();
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page).toHaveURL(/\/transactions$/);
  await expect(page.getByText(/Uncategorized · Everyday/)).toBeVisible();
});

test('edits and deletes manual goal contributions', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/goal');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await page.getByRole('button', { name: 'Open' }).click();

  await page.getByLabel('Add a manual contribution').fill('25');
  await page.getByLabel('Contribution date').fill('2026-07-10');
  await page.getByLabel('Contribution note').fill('First amount');
  await page.getByRole('button', { name: 'Add contribution' }).click();
  await expect(page.getByText(/First amount/)).toBeVisible();

  await page.getByRole('button', { name: /Edit contribution/ }).click();
  await page.getByLabel('Contribution amount').fill('30');
  await page.getByLabel('Contribution note').fill('Corrected amount');
  await page.getByRole('button', { name: 'Save contribution' }).click();
  await expect(page.getByText(/Corrected amount/)).toBeVisible();
  await expect(page.getByText(/First amount/)).toHaveCount(0);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Delete contribution/ }).click();
  await expect(page.getByText('No manual contributions yet.')).toBeVisible();
});

test('shows every category cap and the actual recurring interval', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/budget');
  for (const category of ['Groceries', 'Dining', 'Transport', 'Home']) {
    await page.getByRole('checkbox', { name: category }).click();
    await page.getByLabel(`${category} cap (optional)`).fill('100');
  }
  await page.getByRole('button', { name: 'Create budget' }).click();
  for (const category of ['Groceries', 'Dining', 'Transport', 'Home']) {
    await expect(page.getByText(category, { exact: true })).toBeVisible();
  }

  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('button', { name: 'New recurring' }).click();
  await page.getByLabel('Title').fill('Quarterly bill');
  await page.getByLabel('Amount (USD)').fill('10');
  await page.getByRole('textbox', { name: 'Every, required' }).fill('3');
  await page.getByRole('textbox', { name: 'Starts, required' }).fill('2099-01-01');
  await page.getByRole('button', { name: 'Create schedule' }).click();
  await expect(page.getByText(/Every 3 months\. · Next 2099-01-01/)).toBeVisible();
});

test('uncategorizes, pauses, and resumes a recurring schedule', async ({ page }) => {
  await completeOnboarding(page);
  await page.getByRole('link', { name: 'More' }).click();
  await page.getByRole('button', { name: 'New recurring' }).click();
  await page.getByLabel('Title').fill('Flexible schedule');
  await page.getByLabel('Amount (USD)').fill('10');
  await page.getByRole('radio', { name: 'Dining' }).click();
  await page.getByRole('textbox', { name: 'Starts, required' }).fill('2099-01-01');
  await expect(page.getByRole('switch', { name: 'Post automatically' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Schedule active' })).toBeChecked();
  await page.getByRole('button', { name: 'Create schedule' }).click();

  await page.getByRole('button', { name: /Flexible schedule/ }).click();
  const uncategorized = page.getByRole('radio', { name: 'Uncategorized' });
  await uncategorized.click();
  await expect(uncategorized).toBeChecked();
  await page.getByRole('switch', { name: 'Schedule active' }).click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('button', { name: /Flexible schedule.*Paused/ })).toBeVisible();

  await page.getByRole('button', { name: /Flexible schedule/ }).click();
  await expect(page.getByRole('radio', { name: 'Uncategorized' })).toBeChecked();
  await page.getByRole('switch', { name: 'Schedule active' }).click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('button', { name: /Flexible schedule.*Next 2099-01-01/ })).toBeVisible();
});

test('selects a custom budget start date and labels progress controls', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/budget');
  await page.getByRole('radio', { name: 'Custom' }).click();
  await page.getByLabel('Start date').fill('2099-01-01');
  await page.getByLabel('End date').fill('2099-01-31');
  await expect(page.getByRole('switch', { name: 'Rollover' })).toBeVisible();
  await page.getByRole('button', { name: 'Create budget' }).click();
  await expect(page.getByText(/2099-01-01 to 2099-01-31/)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Everyday spending: Budget progress' })).toBeVisible();

  await page.goto('/goal');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await expect(page.getByRole('progressbar', { name: 'Rainy day fund: Goal progress' })).toBeVisible();
});

test('edits tags carried by an imported transaction', async ({ page }) => {
  await completeOnboarding(page);
  await page.goto('/csv');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose CSV' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles('e2e/fixtures/tagged.csv');
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByText('Ready').locator('..').getByText('1')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Import 1 transactions' }).click();
  await page.goto('/transactions');
  await page.getByRole('button', { name: /Tagged import/ }).click();
  const workTag = page.getByRole('checkbox', { name: 'Work' });
  await expect(workTag).toBeChecked();
  await workTag.click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: /Tagged import/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Work' })).not.toBeChecked();
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
  const destination = page.getByRole('radiogroup', { name: 'To account' }).getByRole('radio', { name: /Savings · USD/ });
  await expect(destination).toBeVisible();
  await page.getByLabel('Amount (USD)').fill('10');
  await destination.click();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByRole('link', { name: /Transactions/ }).click();
  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: /Transfer/ }).click();
  await expect(page.getByText('Transfers do not have categories. Select only income or expense transactions to change categories.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Uncategorized' })).toHaveCount(0);
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
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('button', { name: 'Save appearance' }).click();
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

test('gives keyboard focus a visible ring and themes browser chrome', async ({ page }) => {
  await completeOnboarding(page);

  // react-native-web resets `outline` to none on every pressable it renders, so
  // without the rule in `+html.tsx` this focus is completely invisible.
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus-visible');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveCSS('outline-style', 'solid');
  await expect(focused).toHaveCSS('outline-width', '2px');

  const chrome = await page.evaluate(() => ({
    ring: getComputedStyle(document.activeElement as Element).outlineColor,
    // Drives whether scrollbars and form widgets paint light or dark.
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    focusVar: getComputedStyle(document.documentElement).getPropertyValue('--qashy-focus').trim(),
    selection: getComputedStyle(document.documentElement).getPropertyValue('--qashy-selection').trim(),
    themeColor: document.getElementById('qashy-theme-color-light')?.getAttribute('content'),
  }));
  expect(chrome.colorScheme).toBe('light');
  expect(chrome.focusVar).toMatch(/^#[0-9a-f]{6}$/i);
  expect(chrome.selection).toMatch(/^#[0-9a-f]{6}$/i);
  expect(chrome.ring).not.toBe('rgba(0, 0, 0, 0)');
  // The accent is not a surface the app ever paints, so it must not tint the
  // address bar behind a near-white page.
  expect(chrome.themeColor).toBe('#F6F7F9');
});

test('lays content out against the space the rail leaves, not the window', async ({ page }) => {
  await completeOnboarding(page);
  const rhythm = page.getByRole('heading', { name: 'Spending rhythm' });
  const categories = page.getByRole('heading', { name: 'By category' });
  const stacked = async () => {
    const [first, second] = await Promise.all([rhythm.boundingBox(), categories.boundingBox()]);
    return (second?.y ?? 0) - (first?.y ?? 0) > 100;
  };

  // A 950px window leaves 866px beside the 84px collapsed rail, under the 900px
  // two-column threshold. Measuring the window put these cards side by side in a
  // box 84px narrower than the layout that chose the row assumed it had.
  await page.setViewportSize({ width: 950, height: 1000 });
  await expect.poll(stacked).toBe(true);

  // 1100 leaves 1016px, which genuinely clears the threshold.
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expect.poll(stacked).toBe(false);
});

// `setElementPosition`'s fingerprint: an inline absolute box with no margin.
const detachedCount = (page: Page) => page.evaluate(() => [...document.querySelectorAll('div')].filter((element) => {
  const style = (element as HTMLElement).style;
  return style.position === 'absolute' && style.margin === '0px'
    && Boolean(style.top && style.left && style.width && style.height);
}).length);

test('keeps animated content in flow and fully visible once its entrance ends', async ({ page }) => {
  // Onboarding's second step, deliberately. Softening an entrance with
  // `withInitialValues` made Reanimated generate a keyframe outside its
  // built-in registry, and its web cleanup for that case permanently gave the
  // element `position: absolute` plus a snapshot box about 200ms after mount.
  // Labels left their buttons and the buttons collapsed to their own padding.
  // It takes content mounting *after* a screen's first paint to trigger, since
  // `useEntranceAllowed` suppresses entrances during that first paint. Every
  // wait below clears 1000ms deliberately: Reanimated scales its cleanup timer
  // to 5x the animation duration, and before it fires nothing is wrong yet, so
  // a shorter wait passes against the broken build too.
  await page.goto('/');
  const advance = page.getByRole('button', { name: 'Continue' });
  await expect(advance).toBeVisible();
  await advance.click();

  await page.waitForTimeout(1500);
  await expect(advance).toContainText('Continue');
  expect((await advance.boundingBox())!.width).toBeGreaterThan(80);
  expect(await detachedCount(page)).toBe(0);

  await page.goto('/');

  await completeOnboarding(page);
  await page.goto('/appearance');
  const save = page.getByRole('button', { name: 'Save appearance' });
  await expect(save).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(save).toContainText('Save appearance');
  expect((await save.boundingBox())!.width).toBeGreaterThan(200);
  expect(await detachedCount(page)).toBe(0);

  // The entrance now runs off a shared value, so it also has to actually finish:
  // a stalled one would leave content mounted at opacity 0 instead of misplaced.
  await page.goto('/overview');
  await page.getByLabel('Next month').click();
  await page.waitForTimeout(1500);
  const fadedAncestors = await page.evaluate(() => {
    const label = [...document.querySelectorAll('div')].find((el) => el.textContent === 'CURRENT NET WORTH');
    const faded: number[] = [];
    for (let el = label as HTMLElement | null; el; el = el.parentElement) {
      const opacity = parseFloat(el.style.opacity);
      if (!isNaN(opacity) && opacity < 0.99) faded.push(opacity);
    }
    return faded;
  });
  expect(fadedAncestors).toEqual([]);
});

test('fades the sidebar hover highlight without ever stacking it over the icon', async ({ page }) => {
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const link = page.getByRole('link', { name: 'Transactions' });
  await expect(link).toBeVisible();

  const highlightOpacity = () => page.evaluate(() => {
    const item = [...document.querySelectorAll('a[href="/transactions"]')]
      .find((el) => el.getBoundingClientRect().width > 0)!;
    return parseFloat(getComputedStyle(item.children[0]).opacity);
  });

  // Reanimated's web exit moves a leaving element into a clone appended as the
  // pressable's last child. The hover background paints behind the icon as a
  // real child, but its clone painted on top of it — so the icon blinked for
  // the length of the fade on every hover-out and on the click that made the
  // item active. Nothing may be added to or removed from the item at all.
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('a[href="/transactions"]')]
      .find((el) => el.getBoundingClientRect().width > 0)!;
    (window as unknown as { __churn: number }).__churn = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        (window as unknown as { __churn: number }).__churn += record.addedNodes.length + record.removedNodes.length;
      }
    }).observe(item, { childList: true, subtree: true });
  });

  await link.hover();
  await expect.poll(highlightOpacity).toBeGreaterThan(0.9);
  await page.mouse.move(0, 0);
  await expect.poll(highlightOpacity).toBeLessThan(0.05);
  await link.click();
  await expect(page).toHaveURL(/\/transactions$/);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => (window as unknown as { __churn: number }).__churn)).toBe(0);
});
