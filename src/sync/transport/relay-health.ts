/**
 * "Is the relay down?" — answered directly, rather than inferred from sync being quiet.
 *
 * Without this, an unreachable relay and a vault with nothing to say look identical: both are
 * a screen that says "up to date" and a laptop that never changes. That ambiguity is the
 * worst possible failure mode for a feature whose whole promise is that your devices agree,
 * because the user has no way to tell whether to wait or to go and fix something.
 *
 * Three rules shape the implementation, and each one is a deliberate refusal of the obvious
 * approach:
 *
 * 1. **A dedicated endpoint, not a probe of the real one.** `GET /health` is static, carries
 *    no bucket id, sends no token, and is not correlatable with any vault. Checking liveness
 *    by attempting a real read would tell the relay which vault is asking every time the
 *    question is asked.
 *
 * 2. **On foreground and on demand only.** No timer. A health endpoint pinged on a schedule
 *    is itself a traffic pattern — it says "this device is awake, every five minutes, from
 *    this IP" — which is precisely the metadata §1.8 spends the rest of its effort not
 *    producing. The check rides the same seam sync does.
 *
 * 3. **Advisory, never a gate.** Sync is never blocked on this and never waits for it. Two
 *    devices on the same Wi-Fi sync directly and do not care whether the relay exists, and
 *    the status text says so in as many words instead of implying everything is broken.
 */

import type { StorageTx } from '@/data/storage-adapter';
import { SYNC_META, readMeta, writeMeta } from '@/data/sync-store';
import { readEndpoints } from '@/sync/transport/endpoints';
import {
  RELAY_API_VERSION,
  RelayError,
  looksOffline,
  requestJson,
  type HttpDeps,
  type TransportFailure,
} from '@/sync/transport/http';

export type RelayStatus =
  /** Never checked on this device, or checked against an endpoint that has since changed. */
  | 'unknown'
  /** Switched off, or never configured. Direct connections still work. */
  | 'disabled'
  /** This device has no network. Not the relay's fault, and said differently for that reason. */
  | 'offline'
  | 'reachable'
  /** The host did not answer: DNS, TLS, a refused connection, or a timeout. */
  | 'unreachable'
  /** It answered, and refused this device's write token. */
  | 'unauthorized'
  /** It answered, and is failing — a 5xx, a rate limit, or a run of failed uploads. */
  | 'degraded';

export interface RelayHealth {
  readonly status: RelayStatus;
  /** ISO timestamp of the measurement, or `''` when there has never been one. */
  readonly checkedAt: string;
  /**
   * Why, in transport terms — a status code, a DNS error, a TLS failure.
   *
   * Shown verbatim on screen, because somebody running their own relay needs to know whether
   * it was a 502 or a rejected token. That makes it a surface finance data must never reach:
   * nothing here is derived from a record, a name, or an amount.
   */
  readonly detail: string;
  /** Consecutive failed uploads. What turns a reachable relay into a degraded one. */
  readonly failures: number;
  /** The endpoint this verdict describes, so a stale one is recognisable as stale. */
  readonly endpoint: string;
}

/** Consecutive upload failures before a relay that answers `/health` is still called broken. */
export const RELAY_DEGRADED_AFTER = 3;

const STATUSES = new Set<RelayStatus>([
  'unknown',
  'disabled',
  'offline',
  'reachable',
  'unreachable',
  'unauthorized',
  'degraded',
]);

/**
 * How a transport failure reads as a health verdict.
 *
 * `server` and `rateLimited` are `degraded` rather than `unreachable` because the distinction
 * is the one the user acts on: an unreachable host means check the address, a degraded one
 * means wait or look at the logs. `malformed` is `unreachable` — a 200 full of HTML is a
 * captive portal or the wrong host, and "cannot reach it" is closer to the truth than "it is
 * having problems".
 */
const STATUS_BY_FAILURE: Record<TransportFailure, RelayStatus> = {
  offline: 'offline',
  unreachable: 'unreachable',
  unauthorized: 'unauthorized',
  server: 'degraded',
  rateLimited: 'degraded',
  tooLarge: 'degraded',
  malformed: 'unreachable',
};

/**
 * The longest a `detail` may be.
 *
 * Bounded because it is shown on a settings row and written to a table that is read on every
 * paint. A relay that answers with a novel does not get to put a novel in the database.
 */
export const MAX_DETAIL_LENGTH = 200;

const trim = (detail: string) => detail.slice(0, MAX_DETAIL_LENGTH);

const IDLE: RelayHealth = {
  status: 'unknown',
  checkedAt: '',
  detail: '',
  failures: 0,
  endpoint: '',
};

/**
 * The last verdict, cached.
 *
 * Read on every paint of the More screen, so it touches `sync_meta` and nothing else — no
 * network, no keystore. Without the cache the row would flicker to "unknown" on every launch
 * and answer the user's question with a shrug precisely when they are asking it.
 */
export async function readRelayHealth(tx: StorageTx): Promise<RelayHealth> {
  const [meta, endpoints] = await Promise.all([
    readMeta(tx, [
      SYNC_META.relayStatus,
      SYNC_META.relayCheckedAt,
      SYNC_META.relayDetail,
      SYNC_META.relayFailures,
    ]),
    readEndpoints(tx),
  ]);

  if (!endpoints.relayUrl) {
    return { ...IDLE, status: 'disabled', detail: 'no relay address configured' };
  }
  if (!endpoints.relayEnabled) return { ...IDLE, status: 'disabled', endpoint: endpoints.relayUrl };

  const stored = meta.get(SYNC_META.relayStatus) ?? '';
  const status = STATUSES.has(stored as RelayStatus) ? (stored as RelayStatus) : 'unknown';
  const failures = Number(meta.get(SYNC_META.relayFailures));

  return {
    // A cached `disabled` or `offline` describes a moment, not the endpoint, and replaying it
    // as a current verdict would keep saying "off" after the user switched it back on.
    status: status === 'disabled' || status === 'offline' ? 'unknown' : status,
    checkedAt: meta.get(SYNC_META.relayCheckedAt) ?? '',
    detail: meta.get(SYNC_META.relayDetail) ?? '',
    failures: Number.isSafeInteger(failures) && failures > 0 ? failures : 0,
    endpoint: endpoints.relayUrl,
  };
}

const writeHealth = (tx: StorageTx, health: RelayHealth) =>
  writeMeta(tx, {
    [SYNC_META.relayStatus]: health.status,
    [SYNC_META.relayCheckedAt]: health.checkedAt,
    [SYNC_META.relayDetail]: trim(health.detail),
    [SYNC_META.relayFailures]: String(health.failures),
  });

export interface RelayHealthDeps extends HttpDeps {
  /** Read and written inside `{ silent: true }` transactions: nothing observable changed. */
  readonly transact: <T>(work: (tx: StorageTx) => Promise<T>) => Promise<T>;
  readonly nowIso: () => string;
  readonly signal?: AbortSignal;
}

interface HealthResponse {
  readonly ok?: unknown;
  readonly version?: unknown;
}

/**
 * Measures the relay and caches the verdict.
 *
 * Never throws. A health check that can fail loudly is a health check that turns into an
 * error banner every time a laptop is opened on a train, and the entire point of it is to
 * *replace* the guessing that a failure would otherwise produce.
 */
export async function checkRelayHealth(deps: RelayHealthDeps): Promise<RelayHealth> {
  const { transact, nowIso } = deps;

  const [endpoints, failures] = await transact(async (tx) => {
    const meta = await readMeta(tx, [SYNC_META.relayFailures]);
    const stored = Number(meta.get(SYNC_META.relayFailures));
    return [
      await readEndpoints(tx),
      Number.isSafeInteger(stored) && stored > 0 ? stored : 0,
    ] as const;
  });

  if (!endpoints.relayUrl) {
    return { ...IDLE, status: 'disabled', detail: 'no relay address configured' };
  }
  if (!endpoints.relayEnabled) return { ...IDLE, status: 'disabled', endpoint: endpoints.relayUrl };

  // Short-circuited rather than attempted, and this is the one place that is right: a request
  // that cannot succeed would still take a timeout to fail, and would then be recorded as the
  // relay's fault when the fault is a train tunnel.
  if (looksOffline()) {
    return {
      status: 'offline',
      checkedAt: nowIso(),
      detail: '',
      failures,
      endpoint: endpoints.relayUrl,
    };
  }

  const health = await measure(deps, endpoints.relayUrl, failures);
  await transact((tx) => writeHealth(tx, health));
  return health;
}

async function measure(
  deps: RelayHealthDeps,
  endpoint: string,
  failures: number,
): Promise<RelayHealth> {
  const checkedAt = deps.nowIso();
  const base = { checkedAt, failures, endpoint };

  try {
    const body = await requestJson<HealthResponse>(deps, {
      method: 'GET',
      url: `${endpoint}/health`,
      signal: deps.signal,
    });

    if (body.ok !== true) {
      return { ...base, status: 'unreachable', detail: 'not a Qashy relay' };
    }
    if (typeof body.version === 'number' && body.version !== RELAY_API_VERSION) {
      // Not fatal — the drop-box's shape has been stable and a mismatch is far more likely to
      // mean "deploy the newer worker" than "nothing will work". Saying which version is on
      // each side is the difference between a five-minute fix and an afternoon.
      return {
        ...base,
        status: 'degraded',
        detail: `relay speaks v${body.version}; this app speaks v${RELAY_API_VERSION}`,
      };
    }

    return failures >= RELAY_DEGRADED_AFTER
      ? { ...base, status: 'degraded', detail: `${failures} uploads failed in a row` }
      : { ...base, status: 'reachable', detail: '', failures: 0 };
  } catch (error) {
    if (error instanceof RelayError) {
      return { ...base, status: STATUS_BY_FAILURE[error.code], detail: trim(error.message) };
    }
    const detail = error instanceof Error ? error.message : 'the check failed';
    return { ...base, status: 'unreachable', detail: trim(detail) };
  }
}

/**
 * Records that an upload failed.
 *
 * Counted rather than reported immediately, because one failed upload is ordinary — a network
 * changing hands mid-request — and a status that flips to "errors" on every one of those is a
 * status nobody reads. A run of them is a different claim, and it is the one worth making.
 */
export async function noteRelayFailure(
  tx: StorageTx,
  error: unknown,
  nowIso: string,
): Promise<number> {
  const meta = await readMeta(tx, [SYNC_META.relayFailures]);
  const previous = Number(meta.get(SYNC_META.relayFailures));
  const failures = (Number.isSafeInteger(previous) && previous > 0 ? previous : 0) + 1;
  const detail = error instanceof Error ? error.message : 'upload failed';

  await writeMeta(tx, {
    [SYNC_META.relayFailures]: String(failures),
    [SYNC_META.relayDetail]: trim(detail),
    [SYNC_META.relayCheckedAt]: nowIso,
    ...(failures >= RELAY_DEGRADED_AFTER ? { [SYNC_META.relayStatus]: 'degraded' } : {}),
  });
  return failures;
}

/** Clears the run. One upload landing is proof the relay works, whatever came before it. */
export const noteRelaySuccess = (tx: StorageTx, nowIso: string) =>
  writeMeta(tx, {
    [SYNC_META.relayFailures]: '0',
    [SYNC_META.relayStatus]: 'reachable',
    [SYNC_META.relayDetail]: '',
    [SYNC_META.relayCheckedAt]: nowIso,
  });
