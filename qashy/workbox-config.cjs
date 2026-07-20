module.exports = {
  globDirectory: 'dist',
  globPatterns: ['**/*.{html,js,css,json,png,jpg,jpeg,svg,ico,woff,woff2,ttf,otf}'],
  globIgnores: ['sw.js', 'workbox-*.js'],
  swDest: 'dist/sw.js',
  navigateFallback: '/index.html',
  // Without a denylist the app shell is returned for *any* uncached navigation,
  // so offline requests for real assets, service-worker internals, or the Expo
  // bundle directory resolve to HTML instead of failing like they do online.
  // Anything Expo Router should handle is extensionless, so deny paths that name
  // a file, plus the export's internal directories.
  navigateFallbackDenylist: [
    /^\/_expo\//,
    /^\/assets\//,
    /^\/sw\.js$/,
    /^\/workbox-[^/]+\.js$/,
    /\/[^/?]+\.[^/?]+$/,
  ],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: false,
  maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  runtimeCaching: [],
};
