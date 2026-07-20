import { languageFromLocale, translateMessage } from '@/localization/localization';

describe('localization', () => {
  it('maps supported locale tags to their interface language', () => {
    expect(languageFromLocale('he-IL')).toBe('he');
    expect(languageFromLocale('en-US')).toBe('en');
    expect(languageFromLocale('fr-FR')).toBe('en');
  });

  it('translates interface copy and preserves dynamic currency codes', () => {
    expect(translateMessage('Base currency', 'he')).toBe('מטבע בסיס');
    expect(translateMessage('Opening balance (ILS)', 'he')).toBe('יתרת פתיחה (ILS)');
    expect(translateMessage('  Continue ', 'he')).toBe('  המשך ');
  });

  it('leaves unknown copy and English unchanged', () => {
    expect(translateMessage('Custom account name', 'he')).toBe('Custom account name');
    expect(translateMessage('Base currency', 'en')).toBe('Base currency');
  });
});
