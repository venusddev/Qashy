import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en-US" dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* Fallback title. Routes that render `expo-router/head` override it. */}
        <title>Qashy — Calm Budgeting</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#5966E9" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#121217" media="(prefers-color-scheme: dark)" />
        <meta name="description" content="A calm, private, local-first budget tracker." />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Qashy" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/qashy-icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/qashy-icon-192.png" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: `body { background: #F7F7FB; } @media (prefers-color-scheme: dark) { body { background: #121217; } }` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
