module.exports = {
  globDirectory: 'dist',
  globPatterns: ['**/*.{html,js,css,json,png,jpg,jpeg,svg,ico,woff,woff2,ttf,otf}'],
  globIgnores: ['sw.js', 'workbox-*.js'],
  swDest: 'dist/sw.js',
  navigateFallback: '/index.html',
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: false,
  maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
  runtimeCaching: [],
};
