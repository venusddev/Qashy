/**
 * The small amount of HTTP the app performs, and the rules it performs it under.
 *
 * Qashy makes exactly one kind of network request — sealed bytes to and from a relay the user
 * chose — so this file is the entire attack surface of "the app talks to a server". Keeping it
 * in one place means the timeout, the size cap, the failure taxonomy, and the fact that no
 * request ever carries a cookie, a redirect, or a cache entry are all reviewable at once
 * rather than being properties you have to re-derive at every call site.
 *
 * `fetch` is injected rather than reached for. That is what lets the relay tests exercise a
 * 401, a 502, a truncated body, and a hung connection without a network — the failure paths
 * are the ones that matter here, and they are the hardest to produce against a real server.
 */

export type TransportFailure =
  /** No usable network at all. Distinct because it is not the relay's fault. */
  | 'offline'
  /** DNS, TLS, connection refused, timeout — the host did not answer. */
  | 'unreachable'
  /** The write token was refused. Almost always a stale endpoint or a rotated vault. */
  | 'unauthorized'
  /** The host answered with 5xx. It is up, and it is broken. */
  | 'server'
  /** 413, or a body past the cap. */
  | 'tooLarge'
  /** 429. */
  | 'rateLimited'
  /** A 2xx whose body was not what the protocol says it should be. */
  | 'malformed';

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: TransportFailure,
    /** The HTTP status, when there was one. Shown to self-hosters, who need the specifics. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/**
 * The relay API version this build speaks.
 *
 * Separate from `PROTOCOL_VERSION`, and deliberately so: the relay stores opaque blobs and has
 * no idea what a sync op is, so its wire contract and the vault's wire contract change for
 * entirely unrelated reasons. Conflating them would mean every op-format change forced a
 * server redeploy.
 */
export const RELAY_API_VERSION = 1;

/** How long any single request is allowed to take before it counts as unreachable. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The largest response body accepted, before parsing.
 *
 * One drop-box page of sealed frames, with generous headroom. The point is to refuse a
 * hostile or broken relay's gigabyte before allocating for it, which means checking the
 * declared length *and* the decoded text, since a lying `content-length` is free.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface HttpDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Overridden in tests; on device it is `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/**
 * True when the platform is sure there is no network.
 *
 * Only ever used to explain a failure, never to skip an attempt. `navigator.onLine` is
 * famously optimistic — it reports `true` for a captive portal — so it is trustworthy in one
 * direction only, and that is the direction used here.
 */
export const looksOffline = () =>
  typeof navigator !== 'undefined' && navigator.onLine === false;

interface RequestInput {
  readonly method: 'GET' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * One request, with everything a request in this app is not allowed to do turned off.
 *
 * `credentials: 'omit'` and `redirect: 'error'` are the load-bearing ones. A relay that
 * answers with a 302 to somewhere else must not be followed — the destination would receive
 * the write token in an `authorization` header — and a relay must never be able to set or
 * read a cookie, because a cookie is a correlatable identifier and the entire point of the
 * bucket id is that there is not one.
 */
interface ActiveRequest {
  readonly response: Response;
  readonly signal: AbortSignal;
  finish(): void;
}

const cancelResponseBody = (response: Response): void => {
  const body = response.body as
    | {
        cancel?: () => Promise<unknown>;
        getReader?: () => { cancel(): Promise<unknown> };
      }
    | null;
  try {
    const cancellation =
      typeof body?.cancel === 'function'
        ? body.cancel()
        : typeof body?.getReader === 'function'
          ? body.getReader().cancel()
          : undefined;
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Already locked or already closed. Cancellation is best-effort cleanup; the request's
    // AbortController remains the hard deadline.
  }
};

const connectionFailure = (error: unknown): RelayError => {
  if (error instanceof RelayError) return error;
  if (looksOffline()) return new RelayError('This device is offline.', 'offline');
  const detail = error instanceof Error ? error.message : 'connection failed';
  return new RelayError(`Could not reach the relay: ${detail}`, 'unreachable');
};

async function request(deps: HttpDeps, input: RequestInput): Promise<ActiveRequest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort);
  if (input.signal?.aborted) controller.abort();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  };

  try {
    // A browser's native `window.fetch` is branded: calling it as `deps.fetch(...)` makes
    // `deps` its receiver and throws "Illegal invocation" before any network request leaves
    // the device. Bind it explicitly so injected browser fetch, Expo's fetch, and test doubles
    // all run with the platform global as their receiver.
    const response = await deps.fetch.call(globalThis, input.url, {
      method: input.method,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: {
        accept: 'application/json',
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return { response, signal: controller.signal, finish };
  } catch (error) {
    // Every network-layer failure lands here indistinguishably — `fetch` does not tell you
    // whether it was DNS, TLS, or a refused connection — so they share one classification and
    // the message carries whatever detail the platform did provide.
    finish();
    throw connectionFailure(error);
  }
}

const classify = (status: number): TransportFailure => {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 413) return 'tooLarge';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'server';
  return 'malformed';
};

async function readBoundedText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const declaredHeader = response.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      cancelResponseBody(response);
      throw new RelayError('The relay sent more than this device will accept.', 'tooLarge');
    }
  }

  if (!response.body) {
    throw new RelayError('The relay response has no readable body.', 'malformed');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let received = 0;
  while (true) {
    if (signal.aborted) throw new Error('request timed out');
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new RelayError('The relay sent more than this device will accept.', 'tooLarge');
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/** Performs a request and parses a JSON object out of it, or throws a classified failure. */
export async function requestJson<T>(deps: HttpDeps, input: RequestInput): Promise<T> {
  const active = await request(deps, input);
  const { response } = active;

  try {
    if (!response.ok) {
      cancelResponseBody(response);
      throw new RelayError(
        `The relay answered ${response.status}.`,
        classify(response.status),
        response.status,
      );
    }

    const body = await readBoundedText(response, active.signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new RelayError(
        'The relay sent something that is not a Qashy relay response.',
        'malformed',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RelayError(
        'The relay sent something that is not a Qashy relay response.',
        'malformed',
      );
    }
    return parsed as T;
  } catch (error) {
    throw connectionFailure(error);
  } finally {
    active.finish();
  }
}

/** A request whose response body carries nothing worth reading. */
export async function requestVoid(deps: HttpDeps, input: RequestInput): Promise<void> {
  const active = await request(deps, input);
  try {
    if (!active.response.ok) {
      throw new RelayError(
        `The relay answered ${active.response.status}.`,
        classify(active.response.status),
        active.response.status,
      );
    }
  } finally {
    // PUT and DELETE responses carry no protocol data. Cancel instead of leaving a malicious
    // relay free to stream an ignored body after the operation has already returned.
    cancelResponseBody(active.response);
    active.finish();
  }
}
