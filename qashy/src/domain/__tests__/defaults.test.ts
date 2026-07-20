import { getLocales, type Locale } from 'expo-localization';

import { initialLocalePreferences, initialSettings } from '@/domain/defaults';

const mockedGetLocales = jest.mocked(getLocales);

function locale(languageTag: string, currencyCode: string | null): Locale {
  return {
    languageTag,
    languageCode: languageTag.split(/[-_]/)[0] || null,
    languageScriptCode: null,
    regionCode: null,
    languageRegionCode: null,
    currencyCode,
    currencySymbol: null,
    languageCurrencyCode: currencyCode,
    languageCurrencySymbol: null,
    decimalSeparator: '.',
    digitGroupingSeparator: ',',
    textDirection: 'ltr',
    measurementSystem: null,
    temperatureUnit: null,
  };
}

describe('initial settings', () => {
  afterEach(() => {
    mockedGetLocales.mockReturnValue([locale('en-US', 'USD')]);
  });

  it('keeps usable device locale and currency defaults', () => {
    mockedGetLocales.mockReturnValue([locale('he-IL', 'ILS')]);

    expect(initialSettings()).toMatchObject({ locale: 'he-IL', baseCurrency: 'ILS' });
  });

  it('falls back when the device does not provide usable setup defaults', () => {
    mockedGetLocales.mockReturnValue([locale('en_US', 'XXX')]);

    expect(initialSettings()).toMatchObject({ locale: 'en-US', baseCurrency: 'USD' });
  });

  it('repairs unusable preferences saved before onboarding completes', () => {
    expect(initialLocalePreferences({ locale: 'en_US', baseCurrency: 'XXX' })).toEqual({
      locale: 'en-US',
      baseCurrency: 'USD',
    });
  });
});
