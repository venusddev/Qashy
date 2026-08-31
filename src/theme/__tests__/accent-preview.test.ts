import { Platform } from 'react-native';

import { QASHY_ACCENT } from '@/domain/defaults';
import { previewAccentTokens } from '@/theme/theme';
import { accessibleAccentColor, darkTokens, lightTokens } from '@/theme/tokens';

function withPlatform<T>(os: typeof Platform.OS, run: () => T) {
  const original = Object.getOwnPropertyDescriptor(Platform, 'OS');
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(Platform, 'OS', original);
  }
}

describe('appearance accent preview', () => {
  it('previews a curated accent exactly as the theme applies it', () => {
    expect(previewAccentTokens('preset', '#00A58E', false).accent)
      .toBe(accessibleAccentColor('#00A58E', lightTokens.surface, lightTokens.text));
    expect(previewAccentTokens('custom', '#00A58E', true).accent)
      .toBe(accessibleAccentColor('#00A58E', darkTokens.surface, darkTokens.text));
  });

  it('ignores the stored hex when the accent comes from the system', () => {
    // The chosen hex must not leak into a system-sourced preview, in either
    // direction: the system accent is whatever the platform supplies.
    expect(previewAccentTokens('system', '#FF0000', false).accent)
      .not.toBe(accessibleAccentColor('#FF0000', lightTokens.surface, lightTokens.text));
  });

  it('falls back to the Qashy accent for a system source off Android', () => {
    withPlatform('ios', () => {
      expect(previewAccentTokens('system', '#FF0000', false).accent)
        .toBe(accessibleAccentColor(QASHY_ACCENT, lightTokens.surface, lightTokens.text));
    });
  });

  it('previews the Material You accent rather than a hard-coded indigo', () => {
    withPlatform('android', () => {
      const dynamicPreview = previewAccentTokens('system', '#FF0000', false);
      const indigo = accessibleAccentColor(QASHY_ACCENT, lightTokens.surface, lightTokens.text);
      // The regression was a literal indigo swatch shown no matter what the
      // wallpaper produced. Android's dynamic accent is an opaque platform
      // color, so the guard is that it is no longer a plain hex string at all.
      expect(dynamicPreview.accent).not.toBe(indigo);
      expect(typeof dynamicPreview.accent).not.toBe('string');
      expect(typeof dynamicPreview.onAccent).not.toBe('string');
    });
  });
});
