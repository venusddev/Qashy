import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

/**
 * The six words both devices must be showing.
 *
 * This is the last line of defence in pairing, and the only one a person performs. An
 * attacker who photographed or relayed the QR code can complete a handshake — but not the
 * *same* handshake, so their transcript differs, so these words differ. Someone glancing at
 * two screens and seeing six matching words is the check that catches it.
 *
 * Every deliberate choice here follows from that:
 *
 * - **Large, high-contrast, and numbered.** These are compared across two devices held at
 *   different distances, sometimes by two people reading aloud. The numbers exist so "third
 *   word" is unambiguous, because order matters and a transposition is a failed comparison.
 * - **One `accessibilityLabel` per word, never one for the grid.** A screen reader given six
 *   words as a single run reads them at speed as a phrase; individually, each is announced
 *   with its position and can be re-read.
 * - **The words are never translated.** They come from a fixed English wordlist and are
 *   derived from bytes; a dictionary hit would rewrite one on one device and not the other,
 *   which reads to the user as exactly the attack this screen exists to detect. Only the
 *   `Word 3:` prefix on the accessibility label is localized, and its `translateDynamic`
 *   entry passes the word itself through verbatim.
 * - **Never selectable and never copyable.** Comparing by paste defeats the purpose — the
 *   value is in a human looking at the other screen.
 */
export function SasDisplay({ words }: { words: readonly string[] }) {
  const theme = useQashyTheme();
  const { t } = useLocalization();

  return (
    <View
      accessibilityRole="list"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.sm,
        // Left-to-right in every locale. The words are read as an ordered sequence against
        // another screen, and mirroring the grid under RTL would put word one where the
        // other device shows word three.
        direction: 'ltr',
      }}>
      {words.map((word, index) => (
        <View
          key={`${index}-${word}`}
          accessible
          accessibilityRole="text"
          accessibilityLabel={t(`Word ${index + 1}: ${word}`)}
          style={{
            // Three columns, two rows, however wide the container is.
            flexBasis: '30%',
            flexGrow: 1,
            minHeight: 64,
            alignItems: 'center',
            justifyContent: 'center',
            gap: space.xxs,
            paddingVertical: space.sm,
            paddingHorizontal: space.xs,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surfaceMuted,
          }}>
          <AppText
            selectable={false}
            literal
            variant="eyebrow"
            style={{ color: theme.textMuted }}>
            {String(index + 1)}
          </AppText>
          <AppText
            selectable={false}
            literal
            variant="label"
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ color: theme.text }}>
            {word}
          </AppText>
        </View>
      ))}
    </View>
  );
}
