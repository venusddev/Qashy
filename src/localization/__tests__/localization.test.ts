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
    expect(translateMessage('Create goal', 'he')).toBe('יצירת יעד');
    expect(translateMessage('Every 2 months.', 'he')).toBe('כל 2 חודש');
    expect(translateMessage('75% remains in this period.', 'he')).toBe('75% נותרו בתקופה הזו.');
    expect(translateMessage('Amount is required.', 'he')).toBe('יש למלא את השדה סכום.');
    expect(translateMessage('Enter a valid contribution.', 'he')).toBe('הזינו הפקדה תקין.');
    expect(translateMessage('Use a real target date in YYYY-MM-DD format.', 'he')).toBe('השתמשו בתאריך יעד אמיתי בתבנית YYYY-MM-DD.');
    expect(translateMessage('Missing exchange rate for EUR → ILS on 2026-07-01.', 'he')).toBe('חסר שער חליפין מ־EUR ל־ILS בתאריך 2026-07-01.');
    expect(translateMessage('Delete Rainy day fund?', 'he')).toBe('למחוק את Rainy day fund?');
    expect(translateMessage('Row 3: Unknown category: Old', 'he')).toBe('שורה 3: קטגוריה לא מוכרת: Old');
  });

  it('leaves unknown copy and English unchanged', () => {
    expect(translateMessage('Custom account name', 'he')).toBe('Custom account name');
    expect(translateMessage('Base currency', 'en')).toBe('Base currency');
  });
});
