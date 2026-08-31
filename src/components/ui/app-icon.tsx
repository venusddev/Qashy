// Deep import on purpose. The `@expo/vector-icons` barrel drags every font family
// it exports into the bundle — 18 TTFs, ~2.5MB — even though only Ionicons is used,
// and on web all of that lands in the offline precache too.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { View, type ColorValue } from 'react-native';

type IoniconName = keyof typeof Ionicons.glyphMap;

const IONICON_BY_SF_NAME: Record<string, IoniconName> = {
  plus: 'add',
  'plus.circle': 'add-circle-outline',
  'arrow.up': 'arrow-up',
  'arrow.down': 'arrow-down',
  'arrow.left.arrow.right': 'swap-horizontal',
  'chevron.right': 'chevron-forward',
  'chevron.left': 'chevron-back',
  'chevron.down': 'chevron-down',
  'list.bullet.rectangle': 'receipt-outline',
  // Filled counterparts, used for the selected navigation section. Selection
  // that reads only as a tint fails anyone who cannot separate the two hues,
  // and on the rail the accent container is subtle by design — the change of
  // weight is what actually says "you are here".
  'house.fill': 'home',
  'list.bullet.rectangle.fill': 'receipt',
  'chart.pie.fill': 'pie-chart',
  'ellipsis.circle.fill': 'ellipsis-horizontal-circle',
  magnifyingglass: 'search',
  calendar: 'calendar-outline',
  wallet: 'wallet-outline',
  'wallet.bifold': 'wallet',
  target: 'locate-outline',
  chart: 'pie-chart-outline',
  'chart.pie': 'pie-chart-outline',
  gear: 'settings-outline',
  checkmark: 'checkmark',
  xmark: 'close',
  // Outline, like every other unselected icon. The filled glyph was the only
  // solid shape in the navigation rail, so "More" looked permanently selected.
  'ellipsis.circle': 'ellipsis-horizontal-circle-outline',
  repeat: 'repeat',
  tray: 'download-outline',
  trash: 'trash-outline',
  paintbrush: 'color-palette-outline',
  cart: 'cart-outline',
  'fork.knife': 'restaurant-outline',
  car: 'car-outline',
  house: 'home-outline',
  heart: 'heart-outline',
  sparkles: 'sparkles-outline',
  banknote: 'cash-outline',
  // Sync. Every state a device, a relay, or a batch can be in needs a glyph here: the pills
  // and rows that report them are icon-plus-text by rule, so a missing entry does not degrade
  // to "no icon" on Android and web — it degrades to a question mark sitting next to the word
  // "Reachable", which reads as uncertainty about the very thing being reported.
  'arrow.triangle.2.circlepath': 'sync-outline',
  'arrow.clockwise': 'refresh-outline',
  'point.3.connected.trianglepath.dotted': 'git-network-outline',
  'antenna.radiowaves.left.and.right': 'radio-outline',
  'exclamationmark.triangle': 'warning-outline',
  'checkmark.circle': 'checkmark-circle-outline',
  'xmark.circle': 'close-circle-outline',
  'questionmark.circle': 'help-circle-outline',
  'pause.circle': 'pause-circle-outline',
  // Not a literal match — Ionicons has no struck-through wifi — but "offline" is the meaning,
  // and a cloud with a slash carries it more plainly than a bare wifi glyph would.
  'wifi.slash': 'cloud-offline-outline',
  lock: 'lock-closed-outline',
  'lock.open': 'lock-open-outline',
  'lock.shield': 'shield-checkmark-outline',
  key: 'key-outline',
  // Backup and restore. `arrow.down.circle` is restore specifically — `square.and.arrow.down`
  // already means "import a file", and the two sit next to each other on the transfer screen,
  // so sharing a glyph would make the reversible action and the destructive one look alike.
  folder: 'folder-outline',
  doc: 'document-outline',
  textformat: 'text-outline',
  'arrow.down.circle': 'arrow-down-circle-outline',
  clock: 'time-outline',
  'info.circle': 'information-circle-outline',
  'person.2': 'people-outline',
  qrcode: 'qr-code-outline',
  'doc.on.doc': 'copy-outline',
  pencil: 'create-outline',
  'eye.slash': 'eye-off-outline',
  eye: 'eye-outline',
  'square.and.arrow.up': 'share-outline',
  'square.and.arrow.down': 'download-outline',
  laptopcomputer: 'laptop-outline',
  iphone: 'phone-portrait-outline',
  desktopcomputer: 'desktop-outline',
  globe: 'globe-outline',
};

export function AppIcon({ name, color, size = 20 }: { name: string; color: ColorValue; size?: number }) {
  if (process.env.EXPO_OS === 'ios') {
    return (
      <Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        source={`sf:${name}`}
        tintColor={color as string}
        style={{ width: size, height: size }}
        contentFit="contain"
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={IONICON_BY_SF_NAME[name] ?? 'help-circle-outline'} size={size} color={color} />
    </View>
  );
}
