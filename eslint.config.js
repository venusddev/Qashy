const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// Cryptography is quarantined in `src/sync/crypto/`. Everything else consumes it
// through that directory's documented API, so there is exactly one place to review
// when asking "can this construction be attacked?" — and a stray
// `import { gcm } from '@noble/ciphers/aes'` somewhere in a screen cannot quietly
// introduce a second, unreviewed cryptosystem.
const CRYPTO_PACKAGES = ['@noble/*', '@scure/*'];

module.exports = defineConfig([
  ...expoConfig,
  {
    // `server/` is the relay worker: a separate deployment target with Cloudflare Workers
    // globals, its own tsconfig, and its own `npm run typecheck`. Linting it with the Expo
    // config would only produce noise about an environment it does not run in.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'server/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    // Each exemption is the one file whose entire purpose is the import it is exempt from:
    // `src/sync/crypto/**` is the quarantine itself, and `src/utils/zod.ts` exists only to
    // configure zod before re-exporting it.
    ignores: ['src/sync/crypto/**', 'src/utils/zod.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // Importing zod directly skips `z.config({ jitless: true })`, and the only symptom is
          // a Content Security Policy violation on web that zod itself swallows — so it would
          // reach production looking like nothing at all.
          //
          // This is `paths`, not `patterns`, on purpose: `group` matches gitignore-style, where
          // a pattern with no slash matches *any* path segment, so `'zod'` also flags
          // `@/utils/zod` — the one import that has to be allowed. `paths` compares the module
          // name exactly. The subpath entry below carries a slash, so it anchors to the root.
          paths: [
            {
              name: 'zod',
              message: "Import { z } from '@/utils/zod' so the jitless configuration applies.",
            },
          ],
          patterns: [
            {
              group: CRYPTO_PACKAGES,
              message:
                'Cryptographic primitives may only be imported inside src/sync/crypto/. Use the API that directory exports.',
            },
            {
              group: ['zod/**'],
              message: "Import { z } from '@/utils/zod' so the jitless configuration applies.",
            },
          ],
        },
      ],
    },
  },
  {
    // The sync layer must not log. Op payloads, device ids, and handshake material all
    // pass through it, and a stray `console.log` while debugging is how key material
    // ends up in a crash report.
    files: ['src/sync/**/*.{ts,tsx}'],
    ignores: ['src/sync/**/__tests__/**'],
    rules: {
      'no-console': 'error',
    },
  },
]);
