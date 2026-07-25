module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/utils/**/*.ts', 'src/data/**/*.ts', '!src/data/storage.native.ts', '!src/data/storage.web.ts'],
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
