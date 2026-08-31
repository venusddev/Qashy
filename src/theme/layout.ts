import { createContext, use } from 'react';
import { useWindowDimensions } from 'react-native';

const IS_WEB = process.env.EXPO_OS === 'web';

/** At or above this viewport width the web shell shows a rail instead of the bottom bar. */
export const NAV_RAIL_BREAKPOINT = 768;
/** At or above this viewport width the rail expands from icons into the full sidebar. */
export const NAV_SIDEBAR_BREAKPOINT = 1200;
export const NAV_RAIL_WIDTH = 84;
export const NAV_SIDEBAR_WIDTH = 244;

/** Horizontal space the persistent web navigation takes away from screen content. */
export function navigationRailWidth(windowWidth: number) {
  if (!IS_WEB || windowWidth < NAV_RAIL_BREAKPOINT) return 0;
  return windowWidth < NAV_SIDEBAR_BREAKPOINT ? NAV_RAIL_WIDTH : NAV_SIDEBAR_WIDTH;
}

/**
 * The width of the box a screen actually renders into.
 *
 * The web shell publishes this so screens stop deriving their layout from the
 * window. A screen sitting beside the 84px rail has ~84px less room than
 * `useWindowDimensions` reports, so window-derived breakpoints fired early: a
 * 900px window switched Overview to two columns inside an 816px box, and the
 * chart's pre-measurement estimate was a rail too wide and snapped once it
 * measured itself.
 *
 * Routes outside the shell (onboarding, form sheets, not-found) have no
 * provider above them, and the null default correctly falls back to the window.
 */
export const ContentWidthContext = createContext<number | null>(null);

export interface ScreenMetrics {
  /** The viewport. Use only for things anchored to the viewport, not to content. */
  windowWidth: number;
  /** The room a screen has to lay itself out in. Use this for layout breakpoints. */
  contentWidth: number;
  /** True while the rail or sidebar takes horizontal space beside the content. */
  hasNavigationRail: boolean;
  /** True while the web bottom bar floats over the end of the content. */
  hasBottomNavigation: boolean;
  /**
   * True while the expanded sidebar is showing, which is the only place with
   * room for a permanent primary action. Screens use it to stand their floating
   * button down: a FAB is a mobile answer to "there is nowhere else to put
   * this", and on a desktop with a 244px sidebar that is no longer true.
   */
  hasSidebar: boolean;
}

export function useScreenMetrics(): ScreenMetrics {
  const { width } = useWindowDimensions();
  const provided = use(ContentWidthContext);
  const contentWidth = provided ?? width;
  return {
    windowWidth: width,
    contentWidth,
    hasNavigationRail: contentWidth < width,
    hasBottomNavigation: IS_WEB && provided !== null && width < NAV_RAIL_BREAKPOINT,
    hasSidebar: IS_WEB && provided !== null && width >= NAV_SIDEBAR_BREAKPOINT,
  };
}
