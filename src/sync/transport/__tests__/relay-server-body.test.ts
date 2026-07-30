import { readBoundedRequestBody } from '../../../../server/src/body';

const request = (chunks: readonly Uint8Array[], declaredLength?: number) => {
  let index = 0;
  let cancelled = false;
  return {
    headers: new Headers(
      declaredLength === undefined ? undefined : { 'content-length': String(declaredLength) },
    ),
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false as const, value: chunks[index++] }
              : { done: true as const, value: undefined },
          ),
        cancel: () => {
          cancelled = true;
          return Promise.resolve();
        },
      }),
    },
    cancelled: () => cancelled,
  };
};

describe('relay request body cap', () => {
  it('accepts and joins a body at the exact cap', async () => {
    const input = request([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);

    await expect(readBoundedRequestBody(input, 4)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it('rejects streamed bytes over the cap even when Content-Length lies', async () => {
    const input = request([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], 1);

    await expect(readBoundedRequestBody(input, 4)).resolves.toEqual({
      ok: false,
      reason: 'tooLarge',
    });
    expect(input.cancelled()).toBe(true);
  });

  it('uses a truthful oversized Content-Length as an early rejection', async () => {
    const input = request([new Uint8Array([1])], 9);

    await expect(readBoundedRequestBody(input, 8)).resolves.toEqual({
      ok: false,
      reason: 'tooLarge',
    });
  });
});
