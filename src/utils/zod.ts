/**
 * Zod, configured for a runtime that has no `eval`.
 *
 * Zod 4 compiles validators with `new Function` when it can, and decides whether it can by
 * probing `new Function("")` once and catching the throw. Under the Content Security Policy in
 * `src/utils/csp.ts` that probe is blocked: zod handles it correctly and falls back to the
 * interpreted path, but the browser still fires a `securitypolicyviolation` on every page load.
 * A policy that reports a violation during normal startup is a policy nobody reads, and it would
 * hide the next real one — which is the whole reason `e2e/qashy.spec.ts` asserts *zero*.
 *
 * `jitless` short-circuits ahead of the probe, so nothing is attempted and nothing is reported.
 * It costs no capability: Hermes rejects `new Function` too, so the compiled path was already
 * unreachable on iOS and Android. Setting it globally rather than per-platform means Jest
 * exercises the same validator implementation the app actually runs.
 *
 * Import `z` from here rather than from `zod` directly, so the configuration cannot be bypassed
 * by a module that happens to load first.
 */

import { z } from 'zod';

z.config({ jitless: true });

export { z };
