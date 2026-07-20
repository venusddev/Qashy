import { Link } from 'expo-router';
import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { ScreenContainer } from '@/components/ui/screen-container';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

export default function NotFoundRoute() {
  const theme = useQashyTheme();
  const { t } = useLocalization();

  return (
    <View style={{ flex: 1, backgroundColor: theme.background, alignItems: 'center', justifyContent: 'center' }}>
      <ScreenContainer style={{ alignItems: 'center', gap: 12 }}>
        <AppText variant="title" style={{ textAlign: 'center' }}>Page not found</AppText>
        <AppText variant="body" muted style={{ textAlign: 'center' }}>
          That address doesn’t match anything in Qashy. Your data is untouched.
        </AppText>
        <Link
          href="/overview"
          replace
          style={{
            marginTop: 8,
            minHeight: 48,
            paddingHorizontal: 20,
            paddingVertical: 14,
            borderRadius: 999,
            overflow: 'hidden',
            backgroundColor: theme.accent,
            color: theme.onAccent,
            fontSize: 15,
            fontWeight: '700',
            textAlign: 'center',
          }}>
          {t('Go to Overview')}
        </Link>
      </ScreenContainer>
    </View>
  );
}
