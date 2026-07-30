/**
 * Where this device is willing to send bytes.
 *
 * Every value here is device-local, non-secret, and user-editable, which is the whole point:
 * a sync feature whose server address is compiled in is a sync feature you cannot audit and
 * cannot move. Blanking `relayUrl` genuinely stops this device contacting anything except a
 * peer on the same network.
 *
 * The parsing is deliberately strict rather than forgiving. This is the one string in the app
 * that decides where sealed vault data is uploaded to, so a typo that silently resolves to
 * something unintended is worse than an error message. A URL is accepted only if it is
 * `https:` — or `http:` on a loopback host, which is what a self-hoster's first run and the
 * Playwright fixture both look like — carries no credentials, no query, and no fragment.
 * Everything else is rejected with a reason a person can act on.
 */

import type { StorageTx } from '@/data/storage-adapter';
import { SYNC_META, readMeta, writeMeta } from '@/data/sync-store';

/**
 * The relay this build points at out of the box.
 *
 * Empty on purpose. The relay is a service the vault's owner operates — `server/README.md`
 * is a fifteen-minute deploy — and shipping somebody else's address as a default would mean
 * every install silently uploads to a host chosen by whoever built the binary. Until this is
 * set, sync works over a direct connection and nowhere else, which is a coherent and honest
 * state rather than a broken one.
 */
export const DEFAULT_RELAY_URL = '';

/**
 * The STUN server used when a direct connection cannot be made on the local network.
 *
 * STUN learns one thing: that some IP address asked what its own public address is. It never
 * sees a byte of vault data, and it is contacted only after host candidates have failed, so
 * two devices on the same Wi-Fi never reach it at all. Blank it in settings and LAN sync is
 * unaffected; only sync across two different networks stops working.
 */
export const DEFAULT_STUN_URLS = 'stun:stun.l.google.com:19302';

export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface SyncEndpoints {
  /** Origin only, no trailing slash. `''` when the relay is not configured. */
  readonly relayUrl: string;
  readonly relayEnabled: boolean;
  readonly directEnabled: boolean;
  readonly iceServers: readonly IceServer[];
}

export class EndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Validates and canonicalises an endpoint the user typed.
 *
 * Returns `''` for blank input, which is a valid choice and means "contact nothing".
 */
export function normalizeEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new EndpointError('That is not a complete address. It should start with https://.');
  }

  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new EndpointError('Use https:// — an http:// address would send your data unprotected.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EndpointError('Only https:// addresses can be used here.');
  }
  if (url.username || url.password) {
    throw new EndpointError('Remove the username and password from the address.');
  }
  if (url.search || url.hash) {
    throw new EndpointError('Remove everything after the path from the address.');
  }

  // `origin + pathname` rather than `href`, so a pasted address with a trailing slash and one
  // without produce the same stored value. A path is allowed — a relay behind a shared domain
  // legitimately lives at `/qashy` — but it is normalised to have no trailing slash so the
  // callers can append `/health` without ever producing a double separator.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Splits a comma-separated STUN list.
 *
 * Not `normalizeEndpointUrl`: a STUN URL is `stun:host:port`, which is not an http(s) origin
 * and has no path. It gets its own, narrower check.
 */
export function parseStunUrls(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!/^stuns?:[^\s/?#]+$/.test(entry)) {
        throw new EndpointError(`"${entry}" is not a STUN address. They look like stun:host:3478.`);
      }
      return entry;
    });
}

/** A user-supplied TURN address. Same shape as STUN, different scheme. */
export function normalizeTurnUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!/^turns?:[^\s/?#]+(\?transport=(udp|tcp))?$/.test(trimmed)) {
    throw new EndpointError('That is not a TURN address. They look like turn:host:3478.');
  }
  return trimmed;
}

const flag = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : value === '1';

/**
 * Reads the transport configuration.
 *
 * Tolerant where the writer is strict, and that asymmetry is deliberate. A stored value that
 * no longer parses — because the user hand-edited the database, or because a future version
 * wrote something this one does not understand — must degrade to "that server is not
 * configured" rather than throwing inside a storage transaction on every app launch.
 */
export async function readEndpoints(tx: StorageTx): Promise<SyncEndpoints> {
  const meta = await readMeta(tx, [
    SYNC_META.relayUrl,
    SYNC_META.relayEnabled,
    SYNC_META.directEnabled,
    SYNC_META.stunUrls,
    SYNC_META.turnUrl,
    SYNC_META.turnUsername,
    SYNC_META.turnCredential,
  ]);

  const safely = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };

  const relayUrl = safely(
    () => normalizeEndpointUrl(meta.get(SYNC_META.relayUrl) ?? DEFAULT_RELAY_URL),
    '',
  );
  const stun = safely(
    () => parseStunUrls(meta.get(SYNC_META.stunUrls) ?? DEFAULT_STUN_URLS),
    [] as string[],
  );
  const turnUrl = safely(() => normalizeTurnUrl(meta.get(SYNC_META.turnUrl) ?? ''), '');

  const iceServers: IceServer[] = stun.map((urls) => ({ urls }));
  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      username: meta.get(SYNC_META.turnUsername) ?? '',
      credential: meta.get(SYNC_META.turnCredential) ?? '',
    });
  }

  return {
    relayUrl,
    relayEnabled: flag(meta.get(SYNC_META.relayEnabled), true),
    directEnabled: flag(meta.get(SYNC_META.directEnabled), true),
    iceServers,
  };
}

export interface EndpointPatch {
  readonly relayUrl?: string;
  readonly relayEnabled?: boolean;
  readonly directEnabled?: boolean;
  readonly stunUrls?: string;
  readonly turnUrl?: string;
  readonly turnUsername?: string;
  readonly turnCredential?: string;
}

/**
 * Persists a change to the configuration, validating every field first.
 *
 * Validation happens before the first write rather than field by field, so a patch that sets
 * a good relay URL and a bad STUN list leaves neither behind. A half-applied endpoint change
 * is exactly the state that produces "it worked yesterday" bug reports.
 */
export async function writeEndpoints(tx: StorageTx, patch: EndpointPatch): Promise<void> {
  const entries: Partial<Record<string, string>> = {};

  if (patch.relayUrl !== undefined) {
    entries[SYNC_META.relayUrl] = normalizeEndpointUrl(patch.relayUrl);
    // A relay that has just been pointed somewhere else has no measured health, and showing
    // the previous host's verdict against the new address is worse than showing nothing.
    entries[SYNC_META.relayStatus] = '';
    entries[SYNC_META.relayCheckedAt] = '';
    entries[SYNC_META.relayDetail] = '';
    entries[SYNC_META.relayFailures] = '0';
    // The cursor counts slots in the *old* bucket on the *old* host. Carrying it over would
    // make this device skip the first N blobs it is ever offered by the new one.
    entries[SYNC_META.relayCursor] = '0';
  }
  if (patch.stunUrls !== undefined) {
    entries[SYNC_META.stunUrls] = parseStunUrls(patch.stunUrls).join(',');
  }
  if (patch.turnUrl !== undefined) entries[SYNC_META.turnUrl] = normalizeTurnUrl(patch.turnUrl);
  if (patch.turnUsername !== undefined) entries[SYNC_META.turnUsername] = patch.turnUsername.trim();
  if (patch.turnCredential !== undefined) {
    entries[SYNC_META.turnCredential] = patch.turnCredential.trim();
  }
  if (patch.relayEnabled !== undefined) {
    entries[SYNC_META.relayEnabled] = patch.relayEnabled ? '1' : '0';
  }
  if (patch.directEnabled !== undefined) {
    entries[SYNC_META.directEnabled] = patch.directEnabled ? '1' : '0';
  }

  await writeMeta(tx, entries);
}
