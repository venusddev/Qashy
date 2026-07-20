module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: ['src/utils/**/*.ts', 'src/data/**/*.ts', '!src/data/storage.native.ts', '!src/data/storage.web.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFiles: ['<rootDir>/jest.setup.cjs'],
};
