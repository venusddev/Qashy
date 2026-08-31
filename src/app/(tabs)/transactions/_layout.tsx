import { TabStackLayout } from '@/components/navigation/stack-layout';

export default function Layout() {
  // The ledger pins its search field and filter chips above the list, so the
  // scroll view is not the first thing under the header and a large title has
  // nothing to collapse into. A standard header keeps the filters on screen.
  return <TabStackLayout title="Transactions" largeTitle={false} />;
}
