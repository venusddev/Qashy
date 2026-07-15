# Qashy Agent Guide

Qashy is a private, local-first personal budget app built with Expo SDK 57, React Native, React 19, and Expo Router. It targets iOS, Android, and an installable responsive PWA for desktop and mobile browsers.

Before changing Expo APIs, read the exact SDK 57 documentation at <https://docs.expo.dev/versions/v57.0.0/>. Do not assume examples for older Expo SDKs still apply.

## Product scope

Qashy supports:

- Guided onboarding and editable starter categories.
- Accounts in multiple currencies with manually managed exchange rates.
- Expense, income, and transfer transactions.
- Search, filters, date-grouped lists, and batch category/deletion actions.
- Daily, weekly, monthly, yearly, and custom budgets with rollover snapshots.
- Saving and spending goals with linked or manual contributions.
- Reviewed or automatically posted recurring transactions.
- Dashboard analytics and lightweight SVG charts.
- Validated CSV mapping, preview, atomic import, and UTF-8 export.
- System/light/dark appearance, Material You colors, curated accents, and custom hex colors.
- Offline PWA startup and install/update behavior.

Do not add authentication, cloud sync, bank connections, analytics, advertising, or a remote finance API unless the task explicitly expands the product scope.

## Architecture

- `src/domain/` defines sync-ready entities and defaults.
- `src/data/repository.ts` is the public `FinanceRepository` contract.
- `src/data/local-finance-repository.ts` owns finance rules, queries, aggregates, recurrence, and CSV transactions.
- `src/data/storage.native.ts` persists native records with Expo SQLite, migrations, WAL mode, and exclusive transactions.
- `src/data/storage.web.ts` persists web records in IndexedDB through Dexie. Do not replace it with Expo SQLite web support.
- `src/providers/finance-provider.tsx` initializes and exposes the repository snapshot.
- `src/theme/theme.tsx` owns semantic tokens and platform-specific color behavior.
- `src/features/` contains product screens; route files in `src/app/` should remain thin.
- `src/components/ui/` contains reusable semantic controls and surfaces.
- `src/components/finance/` contains finance-specific presentation components and charts.
- `workbox-config.cjs`, `public/manifest.json`, and the PWA update prompt implement web installation and offline startup.

Keep domain logic out of screen components when it belongs in the repository or a pure utility.

## Data invariants

- Store money as validated safe integers in currency minor units. Never persist floating-point monetary amounts.
- Store exchange rates as decimal strings. Snapshot the applied rate and base-currency minor amount on every transaction.
- Account balances derive from opening balances and posted transactions; never store a mutable current balance.
- Transfers affect both accounts but never income or expense analytics.
- Every persisted entity has a UUID, revision, `createdAt`, `updatedAt`, and nullable `deletedAt`.
- Use soft deletion for finance entities.
- Preserve historical budget period limits, filters, category caps, and rollover values.
- Recurring generation must remain idempotent through occurrence keys.
- Batch mutations and CSV commits must use one adapter `putMany` call so SQLite and Dexie can apply them atomically.
- Validate the complete operation before mutating repository state. Update the in-memory snapshot only after persistence succeeds.
- Do not put finance records in service-worker caches, AsyncStorage, URL parameters, or logs.

When adding or changing an entity, update the model, repository contract, both storage paths if necessary, migrations, and contract tests together.

## Navigation and responsive layout

The primary sections are:

1. Overview
2. Transactions
3. Plan
4. More

Use Expo Router and preserve real public web paths such as `/overview`, `/transactions`, `/plan`, and `/more`.

- Mobile uses four native tabs with nested stacks.
- Web uses bottom navigation below 768px, a compact rail from 768–1199px, and a full sidebar at 1200px and above.
- Creation and editing flows use form-sheet presentation where supported.
- After a sheet mutation, return to or replace with its owning section so repository projections render fresh data on web.
- Route files should generally import and export a feature screen rather than contain business logic.

## UI and theming

- Use semantic values from `useQashyTheme()` instead of hard-coded light/dark surface colors.
- Keep native controls inside the shared `@expo/ui` `Host`.
- Surfaces come from hand-tuned neutral light/dark tokens in `src/theme/tokens.ts`; the chosen accent only drives the accent color family. Android system accent optionally uses dynamic Material colors; iOS and web use the default indigo accent on the same neutral surfaces.
- Liquid Glass is selective: navigation, sheets, and floating actions on supported iOS versions only.
- Always provide blur and opaque reduced-transparency fallbacks.
- Prefer continuous corners, restrained shadows, tabular financial figures, and subtle motion.
- Use `react-native-svg` for shared lightweight charts.
- Maintain 44–48px minimum touch targets and meaningful accessibility roles, labels, and selected states.
- Respect reduced motion and reduced transparency. Do not encode chart meaning through color alone.
- Reuse shared UI components before introducing one-off styling or another component library.

## Platform code

Use platform files when behavior genuinely differs:

- `.native.ts` or `.native.tsx` for iOS and Android.
- `.web.ts` or `.web.tsx` for browsers.
- A non-suffixed file may act as a TypeScript or Metro fallback.

Guard browser globals such as `window`, `document`, `navigator`, `Blob`, and IndexedDB. Guard native-only APIs before using them on web.

## PWA rules

- `npm run build:web` must generate both the Expo static export and Workbox service worker.
- The service worker caches only static app-shell resources.
- Keep `runtimeCaching` empty unless a reviewed non-finance use case requires it.
- Preserve the manifest, update prompt, persistent-storage request, and offline navigation fallback.
- Test service-worker behavior against the production `dist/` export, not the Expo development server.

## Testing and handoff

Run checks proportional to the change. Before handing off a broad or release-facing change, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build:web
npm run test:web
```

Also verify native bundling when touching shared application, routing, storage, or theme code:

```bash
npx expo export -p ios --output-dir /tmp/qashy-ios-export
npx expo export -p android --output-dir /tmp/qashy-android-export
```

Tests should cover money and rate calculations, balances, transfers, recurrence edge cases, rollover snapshots, filters, soft deletion, atomic failures, CSV escaping/deduplication, IndexedDB persistence, responsive navigation, and offline PWA reloads.

Do not use `npm audit fix --force` to resolve transitive Expo advisories; it can install incompatible SDK packages. Report unresolved advisories and upgrade through an intentional Expo SDK update instead.

## Change discipline

- Preserve unrelated user changes in a dirty worktree.
- Keep TypeScript strict and avoid `any` unless an external API makes it unavoidable and the boundary is documented.
- Prefer pure utilities for date, period, money, and CSV calculations.
- Use repository subscriptions rather than duplicating finance state in new global stores.
- Update `README.md` when setup, architecture, scripts, privacy behavior, or supported features change.
- Never commit `dist/`, `test-results/`, native generated folders, credentials, or local environment files.
