/**
 * A `fetch` that never touches a network.
 *
 * Not a `.test.ts` file, so Jest's `testMatch` leaves it alone.
 *
 * The relay code's whole job is behaving well when a server misbehaves, and misbehaviour is
 * precisely what a real server will not do on request. Every failure the transport claims to
 * classify — a 401, a 502, a body of HTML, a connection that never answers — is produced here
 * exactly, in-process, so the taxonomy is tested rather than assumed.
 */

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export type Reply =
  | { readonly kind: 'json'; readonly status?: number; readonly body: unknown }
  | { readonly kind: 'text'; readonly status?: number; readonly body: string }
  | { readonly kind: 'status'; readonly status: number }
  /** A network-layer failure: DNS, TLS, a refused connection. `fetch` rejects. */
  | { readonly kind: 'throw'; readonly message?: string }
  /** A connection that answers nothing, so the timeout is what resolves it. */
  | { readonly kind: 'hang' };

export interface FetchDouble {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Call[];
  /** Queues one reply. Replies are consumed in order; the last one repeats. */
  reply(reply: Reply): void;
}

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const raw = (init?.headers ?? {}) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) headers[name.toLowerCase()] = value;
  return headers;
};

const respond = (reply: Reply): Response => {
  const status = 'status' in reply && reply.status !== undefined ? reply.status : 200;
  const text =
    reply.kind === 'json' ? JSON.stringify(reply.body) : reply.kind === 'text' ? reply.body : '';
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'content-length' ? String(text.length) : null) },
    text: () => Promise.resolve(text),
  } as unknown as Response;
};

export function fetchDouble(...initial: Reply[]): FetchDouble {
  const queue: Reply[] = [...initial];
  const calls: Call[] = [];

  const impl = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });

    const reply = queue.length > 1 ? (queue.shift() as Reply) : (queue[0] ?? { kind: 'json', body: {} });

    if (reply.kind === 'throw') {
      return Promise.reject(new Error(reply.message ?? 'network failure'));
    }
    if (reply.kind === 'hang') {
      // Rejects the way a real `fetch` does when its signal aborts, so the caller's timeout
      // path is the one under test rather than a bespoke error shape.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve(respond(reply));
  }) as unknown as typeof globalThis.fetch;

  return { fetch: impl, calls, reply: (reply) => queue.push(reply) };
}
