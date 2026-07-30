// Loaded dynamically so the app's TypeScript project does not pull in Cloudflare's deployment
// globals. Jest still executes the real Worker router; the relay has its own typecheck config.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const worker = require('../../../../server/src/worker').default as {
  fetch(request: Request, env: unknown): Promise<Response>;
};

const oversizedPut = () => {
  const chunks = [new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024 + 1)];
  let index = 0;
  return {
    url: 'https://relay.example.test/bucket/abcdefghijklmnop',
    method: 'PUT',
    headers: new Headers({
      authorization: 'Bearer attacker-chosen-token',
      'content-length': '1',
    }),
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false as const, value: chunks[index++] }
              : { done: true as const, value: undefined },
          ),
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Request;
};

const environment = (rateAllowed = true) => {
  let named = 0;
  return {
    env: {
      REQUEST_RATE_LIMITER: {
        limit: () => Promise.resolve({ success: rateAllowed }),
      },
      BUCKET: {
        idFromName: () => {
          named += 1;
          return {};
        },
        get: () => ({ fetch: () => Promise.resolve(new Response('{}')) }),
      },
      RENDEZVOUS: {},
    },
    named: () => named,
  };
};

describe('relay outer request gate', () => {
  it('rejects a streamed oversized PUT before naming a Durable Object', async () => {
    const target = environment();

    const response = await worker.fetch(oversizedPut(), target.env);

    expect(response.status).toBe(413);
    expect(target.named()).toBe(0);
  });

  it('applies the shared quota before naming a Durable Object', async () => {
    const target = environment(false);

    const response = await worker.fetch(oversizedPut(), target.env);

    expect(response.status).toBe(429);
    expect(target.named()).toBe(0);
  });
});
