import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#5966E9" />
        <meta name="description" content="A calm, private, local-first budget tracker." />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/qashy-icon.svg" type="image/svg+xml" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: `body { background: #F7F7FB; } @media (prefers-color-scheme: dark) { body { background: #121217; } }` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
