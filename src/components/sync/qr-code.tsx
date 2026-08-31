import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { create } from 'qrcode';

import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

/**
 * A QR code, rendered as vector paths.
 *
 * `qrcode` is used only for the matrix — `create()` is the pure encoder, with none of the
 * renderers attached — and `react-native-svg`, already a dependency for the charts, draws
 * it. Nothing rasterises, so this is one component across iOS, Android, and the browser
 * rather than a canvas path and a native path that could disagree about what they encoded.
 *
 * **The whole matrix is one `<Path>`, not a grid of rects.** A pairing payload needs a
 * version-6-ish symbol, which is 41×41 — over 1600 elements if each dark module were its own
 * node, on a screen that also runs a countdown. One path element is a few hundred bytes of
 * `d` string and draws in a single pass.
 */
export function QrCode({
  value,
  size = 240,
  label,
}: {
  value: string;
  size?: number;
  /** Read out in place of the code itself, which is meaningless spoken aloud. */
  label: string;
}) {
  const theme = useQashyTheme();

  const matrix = useMemo(() => {
    try {
      // 'M' — 15% recovery. Enough for a phone camera at an angle or a slightly smudged
      // screen, without pushing the symbol to a version whose modules are too fine to
      // scan from a laptop display at arm's length.
      const { modules } = create(value, { errorCorrectionLevel: 'M' });
      return { count: modules.size, path: toPath(modules.size, modules.data) };
    } catch {
      // `create` throws when the payload exceeds what any version can hold. That is a bug
      // in whatever built the payload, but it must not take the pairing screen down with
      // it — the screen has a manual-code fallback that still works.
      return null;
    }
  }, [value]);

  if (!matrix) {
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space.lg,
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.surfaceMuted,
        }}>
        <AppText variant="caption" muted style={{ textAlign: 'center' }}>
          This code is too long to show as a QR code. Use the manual code instead.
        </AppText>
      </View>
    );
  }

  // A quiet zone of four modules is required by the spec, and scanners genuinely fail
  // without it. Expressed in module units so it scales with the symbol rather than being a
  // pixel value that is right at one size only.
  const quiet = 4;
  const extent = matrix.count + quiet * 2;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        padding: space.md,
        borderRadius: radius.card,
        // Always light, in both themes, and deliberately not a semantic token. A QR code is
        // read by a camera, not a person: dark-on-light is what the spec assumes and what
        // every scanner is tuned for, and an inverted symbol fails on a good number of them.
        backgroundColor: '#FFFFFF',
      }}>
      <Svg width={size} height={size} viewBox={`0 0 ${extent} ${extent}`}>
        <Rect x={0} y={0} width={extent} height={extent} fill="#FFFFFF" />
        <Path d={matrix.path} fill="#000000" transform={`translate(${quiet}, ${quiet})`} />
      </Svg>
    </View>
  );
}

/**
 * The dark modules as one path, run-length encoded along each row.
 *
 * Adjacent dark modules become a single wide rectangle rather than several one-unit ones.
 * Beyond being smaller, this closes the hairline seams that appear between abutting
 * rectangles when the SVG is scaled to a non-integer size — which on a QR code is not
 * cosmetic, because a scanner reading those seams sees a module boundary that is not there.
 */
function toPath(count: number, data: Uint8Array): string {
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    let start = -1;
    for (let column = 0; column <= count; column += 1) {
      const dark = column < count && data[row * count + column] === 1;
      if (dark && start < 0) start = column;
      if (!dark && start >= 0) {
        parts.push(`M${start} ${row}h${column - start}v1h${start - column}z`);
        start = -1;
      }
    }
  }
  return parts.join('');
}
