/**
 * Reads an incoming request body without ever buffering more than the caller's cap.
 *
 * `Content-Length` is only an early rejection: clients and intermediaries may omit it or lie.
 * The streaming byte count is the authority.
 */

export type BoundedBody =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'tooLarge' };

interface ByteReader {
  read(): Promise<
    | { readonly done: true; readonly value?: undefined }
    | { readonly done: false; readonly value: Uint8Array }
  >;
  cancel(): Promise<unknown>;
}

interface BodySource {
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): ByteReader } | null;
}

export async function readBoundedRequestBody(
  request: BodySource,
  maxBytes: number,
): Promise<BoundedBody> {
  const declaredHeader = request.headers.get('content-length');
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: 'tooLarge' };
    }
  }

  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'tooLarge' };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
