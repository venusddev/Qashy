# Qashy

Qashy is a private, local-first personal budget app for iOS, Android, and the web. It tracks accounts, expenses, income, transfers, budgets, goals, recurring transactions, exchange rates, and CSV imports without requiring an account or backend.

## Run locally

```bash
npm install
npm start
```

Open the project in Expo Go for iOS or Android, or press `w` for the responsive web app.

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build:web
npm run test:web
```

`npm run build:web` creates the static PWA and its Workbox service worker in `dist/`. Serve that directory over HTTPS (or localhost) to test installation and offline startup.

## Architecture

- `src/domain` contains sync-ready finance entities. Money is stored as integer minor units; exchange rates are decimal strings and each transaction snapshots its base-currency value.
- `src/data/local-finance-repository.ts` is the shared repository contract implementation for atomic transfers, derived balances, budgets, recurring occurrences, dashboard aggregation, soft deletion, and CSV portability.
- `src/data/storage.native.ts` persists records through Expo SQLite with versioned migrations and WAL mode.
- `src/data/storage.web.ts` persists the same records in IndexedDB through Dexie. The service worker caches only the app shell; it never caches finance records.
- `src/theme` centralizes semantic light/dark tokens, curated and custom accents, Android dynamic colors, and web tonal palettes.
- `src/app` uses Expo Router with four mobile tabs and responsive web navigation: bottom bar, compact rail, then full sidebar.

## Privacy and portability

Qashy has no authentication, analytics, remote finance API, or cloud sync. Native records stay in SQLite and web records stay in IndexedDB. CSV export is UTF-8 with stable columns; import validates and previews rejected and duplicate rows before committing.

Clearing app storage or browser site data removes local records. Export CSV data regularly if it is your only copy.
