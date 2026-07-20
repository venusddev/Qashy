let uuid = 0;

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageTag: 'en-US', currencyCode: 'USD' }]),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
}));
