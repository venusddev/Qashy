import { Image } from 'expo-image';
import { Text, View, type ColorValue } from 'react-native';

const FALLBACKS: Record<string, string> = {
  plus: '+',
  'arrow.up': '↑',
  'arrow.down': '↓',
  'arrow.left.arrow.right': '⇄',
  'chevron.right': '›',
  magnifyingglass: '⌕',
  calendar: '◫',
  wallet: '◉',
  'wallet.bifold': '◉',
  target: '◎',
  chart: '▥',
  gear: '⚙',
  checkmark: '✓',
  xmark: '×',
  'ellipsis.circle': '•••',
  repeat: '↻',
  tray: '⇩',
  paintbrush: '◆',
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
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color, fontSize: size * 0.85, fontWeight: '700', lineHeight: size }}>{FALLBACKS[name] ?? '•'}</Text>
    </View>
  );
}
