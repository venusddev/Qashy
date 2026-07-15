import { Redirect } from 'expo-router';

import { useFinanceState } from '@/providers/finance-provider';

export default function IndexRoute() {
  const { settings } = useFinanceState();
  return <Redirect href={settings.onboardingComplete ? '/overview' : '/onboarding'} />;
}
