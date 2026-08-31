const expoPreset = require('jest-expo/jest-preset.js');

// The `@noble` and `@scure` crypto packages ship ESM only — no `require` condition — so
// Jest has to transform them or it hits "Cannot use import statement outside a module"
// the first time any sync code loads. jest-expo's pattern is a negative lookahead listing
// the scopes it *will* transform, so the fix is to add ours to that list. Derived from the
// preset rather than pasted, because a hard-coded copy silently stops matching the day
// jest-expo adds a scope of its own.
const TRANSFORM_ALSO = '@noble|@scure';
const transformIgnorePatterns = expoPreset.transformIgnorePatterns.map((pattern) =>
  pattern.startsWith('/node_modules/(?!(') ? pattern.replace('(?!(', `(?!(${TRANSFORM_ALSO}|`) : pattern,
);

module.exports = {
  preset: 'jest-expo',
  transformIgnorePatterns,
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/utils/**/*.ts',
    'src/data/**/*.ts',
    'src/sync/**/*.ts',
    '!src/data/storage.native.ts',
    '!src/data/storage.web.ts',
    // Platform-suffixed sync files need a device or a browser; the shared cores they
    // delegate to are covered directly.
    '!src/sync/**/*.native.ts',
    '!src/sync/**/*.web.ts',
    // Fixtures and helpers that live beside the suites are not production code.
    '!src/**/__tests__/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // tsconfig maps `dexie` to its declaration file to work around the package's
    // missing `types` export condition, and the Expo jest resolver honours those
    // paths — which would hand Jest a .d.ts to execute. Point the runtime at the
    // real bundle instead.
    '^dexie$': '<rootDir>/node_modules/dexie/dist/dexie.js',
  },
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  // Dexie's cache middleware arms a fixed 3s cleanup timer for every readwrite
  // transaction and for every released `liveQuery` subscription (dexie.js,
  // `enqueForDeletion`). Nothing in this project owns that timer or can cancel it,
  // so the storage suites always finish with one pending handle and Jest prints
  // "did not exit one second after the test run has completed" on an otherwise
  // green run — and then sat idle for those 3s before exiting anyway. Exit on
  // completion instead of training everyone to ignore a warning that never
  // indicates anything. A handle that genuinely never clears still shows up, as a
  // suite that stops producing output.
  forceExit: true,
};
