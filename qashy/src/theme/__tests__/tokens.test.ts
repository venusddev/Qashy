import {
  accessibleAccentColor,
  contrastRatio,
  ensureContrast,
  readableTextColor,
} from '@/theme/tokens';

describe('theme contrast', () => {
  it.each(['#E7892C', '#36A852', '#FF8F96', '#5966E9'])(
    'chooses readable text for %s',
    (background) => {
      expect(contrastRatio(readableTextColor(background), background)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('adjusts accents that disappear into their surface', () => {
    const accent = accessibleAccentColor('#FFFFFF', '#FFFFFF', '#191B20');
    expect(contrastRatio(accent, '#FFFFFF')).toBeGreaterThanOrEqual(3);
  });

  it('preserves hue as far as possible while meeting text contrast', () => {
    const foreground = ensureContrast('#E7892C', '#FFF4E9', '#191B20');
    expect(contrastRatio(foreground, '#FFF4E9')).toBeGreaterThanOrEqual(4.5);
    expect(foreground).not.toBe('#191B20');
  });
});
