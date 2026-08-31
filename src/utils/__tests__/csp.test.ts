/**
 * The policy's shape, not its effect.
 *
 * Whether the exported app actually runs under it is a browser question and belongs in
 * `e2e/qashy.spec.ts`, which loads the real `dist/` and fails on a violation. What can be
 * checked here — cheaply, on every run — is that nobody has quietly loosened it. Every
 * assertion below corresponds to a directive that would still *work* if it were relaxed, which
 * is exactly why a relaxation would survive review without a test to object.
 */

import { CONTENT_SECURITY_POLICY, INLINE_SCRIPT_HASHES } from '@/utils/csp';

const directive = (name: string) =>
  CONTENT_SECURITY_POLICY.split('; ')
    .find((entry) => entry.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe('the exported content security policy', () => {
  it('denies anything it did not name', () => {
    // The reason a new fetch type has to be added deliberately rather than inheriting a
    // permissive fallback.
    expect(directive('default-src')).toBe("'none'");
  });

  it('runs no script this build did not ship', () => {
    const scriptSrc = directive('script-src');
    // The single most valuable line in the file. `'unsafe-inline'` here would let an injected
    // <script> ask the unwrapped vault key to decrypt on the attacker's behalf.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    const sources = scriptSrc?.split(' ') ?? [];
    expect(sources[0]).toBe("'self'");
    expect(sources).toHaveLength(1 + INLINE_SCRIPT_HASHES.length);
  });

  it('quotes every hash source, because an unquoted one silently allows nothing', () => {
    // This is a real bug that shipped, not a hypothetical. `sha256-…` without quotes is not a
    // parse error — the browser reads it as a host source and drops it, so the directive
    // enforces `'self'` alone and the inline script it was meant to permit is blocked. The
    // previous version of this test rebuilt the expected value from `INLINE_SCRIPT_HASHES`,
    // which meant it agreed with whatever the module produced and could never catch this.
    expect(INLINE_SCRIPT_HASHES.length).toBeGreaterThan(0);
    for (const hash of INLINE_SCRIPT_HASHES) {
      // Stored bare, the form a hashing tool emits.
      expect(hash).toMatch(/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/);
      // Emitted quoted, the only form the grammar accepts.
      expect(directive('script-src')).toContain(`'${hash}'`);
    }
    for (const source of directive('script-src')?.split(' ').slice(1) ?? []) {
      expect(source).toMatch(/^'sha(256|384|512)-[A-Za-z0-9+/]+=*'$/);
    }
  });

  it('closes the three routes that turn an injection into execution', () => {
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
    expect(directive('frame-src')).toBe("'none'");
  });

  it('permits only encrypted transports out', () => {
    const connect = directive('connect-src');
    // Cannot be an endpoint allow-list: the relay address is user-editable at runtime and this
    // policy is fixed at build time. What it can still do is refuse the cleartext schemes.
    expect(connect).toBe("'self' https: wss:");
    expect(connect).not.toContain('http:');
    expect(connect).not.toContain('data:');
  });

  it('does not claim a protection a meta tag cannot deliver', () => {
    // `frame-ancestors` is ignored outside a real response header. Listing it would read as
    // clickjacking protection this build does not have.
    expect(CONTENT_SECURITY_POLICY).not.toContain('frame-ancestors');
    expect(CONTENT_SECURITY_POLICY).not.toContain('report-uri');
  });

  it('admits the one thing react-native-web makes unavoidable, and only that', () => {
    expect(directive('style-src')).toBe("'self' 'unsafe-inline'");
    // If `'unsafe-inline'` ever appears anywhere else, this is the test that says so.
    const relaxed = CONTENT_SECURITY_POLICY.split('; ').filter((entry) =>
      entry.includes("'unsafe-inline'"),
    );
    expect(relaxed).toEqual(["style-src 'self' 'unsafe-inline'"]);
  });
});
