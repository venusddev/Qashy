import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { QASHY_INDIGO, darkTokens, lightTokens } from '@/theme/tokens';

// Derived from the same tokens the app renders with, rather than hand-copied. The
// static shell used to carry its own `#F7F7FB`/`#121217` pair while the app painted
// `#F6F7F9`/`#0E0F13`, so first paint stepped to a different colour in both schemes
// and the address-bar tint never matched the page behind it.
const LIGHT_BACKGROUND = lightTokens.background;
const DARK_BACKGROUND = darkTokens.background;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en-US" dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* Fallback title. Routes that render `expo-router/head` override it. */}
        <title>Qashy — Calm Budgeting</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content={QASHY_INDIGO} media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content={DARK_BACKGROUND} media="(prefers-color-scheme: dark)" />
        <meta name="description" content="A calm, private, local-first budget tracker." />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Qashy" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/qashy-icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/qashy-icon-192.png" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: `body { background: ${LIGHT_BACKGROUND}; } @media (prefers-color-scheme: dark) { body { background: ${DARK_BACKGROUND}; } }` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
