import { Ionicons } from '@expo/vector-icons';
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
  'ellipsis.circle': 'ellipsis-horizontal-circle',
  repeat: 'repeat',
  tray: 'download-outline',
  paintbrush: 'color-palette-outline',
  cart: 'cart-outline',
  'fork.knife': 'restaurant-outline',
  car: 'car-outline',
  house: 'home-outline',
  heart: 'heart-outline',
  sparkles: 'sparkles-outline',
  banknote: 'cash-outline',
};

export function AppIcon({ name, color, size = 20 }: { name: string; color: ColorValue; size?: number }) {
  if (process.env.EXPO_OS === 'ios') {
    return (
      <Image
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
