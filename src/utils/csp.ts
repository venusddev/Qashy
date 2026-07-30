/**
 * The Content Security Policy the exported web app ships with.
 *
 * Sync moved the web build from "a page that would rather not be attacked" to "a page holding
 * a key that decrypts every transaction the user has ever entered". The keystore wraps that key
 * in a non-extractable `CryptoKey`, which stops it being *read* — but an attacker running script
 * in this origin does not need to read it, because they can ask the unwrapped handle to decrypt
 * for them. The only real defence is that no foreign script runs here at all, and that is what
 * this policy is for. It is a mitigation for the limit `docs/sync-threat-model.md` states
 * plainly rather than a claim that the limit has gone away.
 *
 * Three directives do the actual work:
 *
 * - **`script-src 'self'` plus one hash, and no `'unsafe-inline'`.** An injected `<script>` or a
 *   `javascript:` URL does not execute. The hash covers exactly one 39-byte line that Expo
 *   Router puts in every exported page; see `EXPO_HYDRATE_SCRIPT_HASH`.
 * - **`default-src 'none'`.** Anything this file forgot is denied rather than allowed, so a
 *   future fetch type has to be added deliberately.
 * - **`object-src 'none'` and `base-uri 'none'`.** Plugin content and `<base>` rewriting are two
 *   classic ways to turn a same-origin injection into script execution.
 *
 * And the honest limits:
 *
 * - **`style-src` needs `'unsafe-inline'` and there is no way around it.** react-native-web
 *   builds the entire stylesheet at runtime and sets `style` attributes on elements; this file's
 *   own `<style>` block is a rounding error beside that. CSS injection is a defacement and a
 *   data-exfiltration channel in some browsers, not code execution, so this is the weak link
 *   rather than a hole.
 * - **`connect-src` cannot be an allow-list of endpoints.** The relay address is user-editable
 *   at runtime — self-hosting it is a product promise — and a `<meta>` policy is fixed at build
 *   time. `https:` and `wss:` are as tight as this can honestly be: it still blocks `http:`,
 *   `data:`, and `blob:` exfiltration, and the payload is E2EE regardless of where it is sent.
 *   A deployment that knows its relay can tighten this in a response header.
 * - **`frame-ancestors` is ignored in a `<meta>` policy** and is deliberately not listed here so
 *   nobody reads it and believes it. Clickjacking protection needs a real response header
 *   (`frame-ancestors 'none'` or `X-Frame-Options: DENY`), which is a hosting concern —
 *   `docs/sync-threat-model.md` records it as such.
 */

/**
 * `globalThis.__EXPO_ROUTER_HYDRATE__=true;` — the one inline script in the export.
 *
 * Pinned as a hash rather than waved through with `'unsafe-inline'`, because `'unsafe-inline'`
 * on `script-src` would give up the single most valuable directive here to accommodate 39 bytes.
 *
 * If Expo Router ever changes that line, hydration stops and the app renders a blank page —
 * loud, but at build time rather than in front of a user, which is why `e2e/qashy.spec.ts`
 * asserts the exported pages contain no inline script this list does not cover.
 */
export const EXPO_HYDRATE_SCRIPT_HASH = 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8=';

/**
 * Every inline script the export is allowed to run, in the bare form a hashing tool emits
 * (`openssl dgst -sha256 -binary | base64`), *without* the surrounding quotes.
 *
 * The grammar requires a hash source to be quoted — `'sha256-…'`, not `sha256-…`. An unquoted
 * one is not a parse error: the browser reads it as a host source, ignores it, and enforces the
 * rest of the directive as though the hash were never listed, so hydration silently stops. That
 * is exactly what shipped for one build here. `quoteSource` is the single place the quotes go on,
 * and `csp.test.ts` asserts the assembled text rather than re-deriving it from this array.
 */
export const INLINE_SCRIPT_HASHES: readonly string[] = [EXPO_HYDRATE_SCRIPT_HASH];

const quoteSource = (hash: string) => `'${hash}'`;

const DIRECTIVES: readonly (readonly [string, string])[] = [
  // Deny by default; every fetch type below is an explicit exception.
  ['default-src', "'none'"],
  ['script-src', ["'self'", ...INLINE_SCRIPT_HASHES.map(quoteSource)].join(' ')],
  // See the note above — react-native-web leaves no choice.
  ['style-src', "'self' 'unsafe-inline'"],
  // `data:` for the icon font's inlined glyphs, `blob:` for the QR bitmap path.
  ['img-src', "'self' data: blob:"],
  ['font-src', "'self' data:"],
  // The camera preview attaches a `MediaStream` via `srcObject`, which CSP does not police;
  // `blob:` covers the fallback that goes through an object URL instead.
  ['media-src', "'self' blob:"],
  // The relay and the rendezvous, wherever the user has pointed them. `'self'` additionally
  // covers same-origin `ws:` during development.
  ['connect-src', "'self' https: wss:"],
  // The Workbox service worker, which is same-origin and generated at build time.
  ['worker-src', "'self'"],
  ['manifest-src', "'self'"],
  // Nothing in Qashy is framed, submits a form, or embeds a plugin.
  ['frame-src', "'none'"],
  ['object-src', "'none'"],
  ['form-action', "'none'"],
  ['base-uri', "'none'"],
];

/** The policy as it appears in the `content` attribute. */
export const CONTENT_SECURITY_POLICY = DIRECTIVES.map(
  ([name, value]) => `${name} ${value}`,
).join('; ');
