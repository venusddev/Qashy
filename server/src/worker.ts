/**
 * The Qashy relay — a blind pipe, and nothing else.
 *
 * This is the whole server side of sync. It is deliberately small, deliberately stateless
 * about identity, and deliberately incapable of reading anything it stores. Read it in full
 * before you deploy it; that is the point of it being this size.
 *
 * It does exactly three things:
 *
 * 1. `GET /health` — answers `{ ok: true, version: 1 }`. No id, no auth, no logging, nothing
 *    correlatable. It exists so the app can say "the relay is down" instead of leaving the
 *    user to infer it from sync being quiet.
 * 2. `GET /rendezvous/:id` (WebSocket) — relays opaque text between exactly two parties that
 *    independently arrived at the same rotating id. It stores nothing, not even in memory
 *    between messages, and the id changes every five minutes.
 * 3. `PUT|GET|DELETE /bucket/:id` — a drop-box. Devices leave sealed, padded frames addressed
 *    to a blinded route tag; devices collect what is addressed to them, from a cursor.
 *
 * **What this server can see, exhaustively:** an opaque 52-character id, a 16-character route
 * tag, a small integer, some padded base64url ciphertext, and an IP address. It cannot see who
 * you are, what changed, how many records you have, or that two buckets belong to the same
 * person. Every id is an HKDF output of a vault root key it has never held and cannot derive.
 *
 * **What it can still do, and what stops it mattering:** it can drop a blob, reorder a page,
 * replay one, or refuse service. None of those corrupt a vault — every frame is AEAD-sealed
 * under a key the server has never seen, every op batch is Ed25519-signed by the device that
 * wrote it and hash-chained to that device's previous batch, and a gap, a rewind, or a fork is
 * rejected by the client rather than merged. A hostile relay is a denial of service. It is not
 * a disclosure and it is not a corruption.
 *
 * There is no account, no session, no cookie, and no log of who asked for what. Adding any of
 * those would break the claim the app makes on its own settings screen, so don't.
 */

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  readonly BUCKET: DurableObjectNamespace;
  readonly RENDEZVOUS: DurableObjectNamespace;
  /** Days an undelivered blob is kept. Defaults to 14; see `wrangler.toml`. */
  readonly RETENTION_DAYS?: string;
}

/**
 * The relay wire version, which must match `RELAY_API_VERSION` in the app.
 *
 * Deliberately separate from the sync protocol version: this server stores opaque blobs and
 * has no idea what a sync op is, so the two change for entirely unrelated reasons. Conflating
 * them would mean every op-format change forced a redeploy of a server that does not care.
 */
const RELAY_API_VERSION = 1;

/**
 * Ids are 52 base32 characters today. The bounds are wider than that on purpose — this file
 * must not need a redeploy because the client changed a `slice()` — and narrow enough that a
 * caller cannot use the id as a smuggling channel or make an unbounded number of objects out
 * of one request.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Route tags are 16 base32 characters. Same reasoning, same latitude. */
const TAG_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * The largest single frame accepted, measured on the base64url text.
 *
 * A full 1 000-op batch seals and pads to comfortably under this. Durable Object SQLite caps
 * a single value at 2 MB, so this leaves real headroom rather than sitting on the limit. A
 * frame past it is refused with `413`, which the app classifies as `tooLarge` and shows to the
 * user — a visible, actionable failure, and direct sync is unaffected.
 */
const MAX_FRAME_CHARS = 1_400_000;

/** The largest request body read at all, before parsing. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Blobs held per bucket. Reached only when a peer has been away long enough to matter. */
const MAX_BLOBS_PER_BUCKET = 5_000;

/** Blobs returned per page, whatever the caller asks for. */
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;

/** Matches `MAX_SIGNAL_BYTES` in the app. A handshake message is a few hundred bytes. */
const MAX_SIGNAL_CHARS = 64 * 1024;

/** A rendezvous id rotates every five minutes; twice that is generous for a slow handshake. */
const RENDEZVOUS_TTL_MS = 10 * 60 * 1000;

const DEFAULT_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * CORS, opened wide, which is safe here for one specific reason.
 *
 * The PWA is served from a different origin than the relay, so cross-origin requests are
 * unavoidable. `*` is normally a smell; it is fine here because there is no ambient authority
 * to steal — no cookies, no sessions, no origin-bound state of any kind. Authorization is a
 * bearer token derived from a key the browser had to already hold, and the app sends
 * `credentials: 'omit'`. An attacker's page calling this endpoint learns exactly what a
 * stranger with `curl` learns, which is nothing.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

const json = (status: number, body: unknown, extra?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Nothing this server returns may be cached by anything, ever. A shared cache holding a
      // bucket page would hand one vault's ciphertext to whoever asked next.
      'cache-control': 'no-store',
      ...CORS,
      ...extra,
    },
  });

/**
 * An error, carrying a code and nothing else.
 *
 * No echo of the id, the token, the path, or the body. An error message is a side channel,
 * and a relay that repeats what it was sent is a relay that can be used to confirm a guess.
 */
const fail = (status: number, code: string, extra?: Record<string, string>) =>
  json(status, { error: code }, extra);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === '/health') {
      if (request.method !== 'GET') return fail(405, 'method');
      // Static, unauthenticated, and identical for every caller. That is the entire design:
      // a health check that carried a bucket id would tell the relay which vault is asking
      // every single time the app is opened, which is worse metadata than sync itself emits.
      return json(200, { ok: true, version: RELAY_API_VERSION });
    }

    const rendezvous = /^\/rendezvous\/([^/]+)$/.exec(path);
    if (rendezvous) {
      const id = decodeURIComponent(rendezvous[1]);
      if (!ID_PATTERN.test(id)) return fail(400, 'id');
      // Named by the id itself, so two devices computing the same HKDF output land in the same
      // object without either of them ever telling the server who they are.
      const stub = env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(id));
      return stub.fetch(request);
    }

    const bucket = /^\/bucket\/([^/]+)$/.exec(path);
    if (bucket) {
      const id = decodeURIComponent(bucket[1]);
      if (!ID_PATTERN.test(id)) return fail(400, 'id');
      const stub = env.BUCKET.get(env.BUCKET.idFromName(id));
      return stub.fetch(request);
    }

    return fail(404, 'route');
  },
};

// ---------------------------------------------------------------------------
// Bucket — the drop-box
// ---------------------------------------------------------------------------

interface BlobRow {
  readonly slot: number;
  readonly recipient: string;
  readonly seq: number;
  readonly frame: string;
}

/**
 * One vault's drop-box.
 *
 * A Durable Object rather than KV for one reason that matters and one that is merely
 * convenient. The one that matters: the client's cursor is a monotonic integer, and allocating
 * monotonic integers needs serialization that KV cannot provide — two devices uploading at the
 * same moment would otherwise collide on a slot and one blob would be invisible forever. The
 * convenient one: `DELETE` and expiry become one statement instead of a list-and-loop.
 */
export class BucketRoom {
  private readonly sql: SqlStorage;
  /**
   * A coarse abuse brake, in memory and therefore approximate.
   *
   * It resets when the object is evicted, which is fine: it exists to stop a loop, not a
   * determined attacker. Real rate limiting belongs in a Cloudflare WAF rule in front of the
   * worker, where it can see an IP; see the README. Doing it properly here would mean storing
   * per-IP state, which is precisely the thing this server must not do.
   */
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      // `AUTOINCREMENT`, not a bare `INTEGER PRIMARY KEY`, and the difference is load-bearing:
      // a plain rowid is reused after a purge, so a device holding cursor 50 would silently
      // never see the new slot 1. AUTOINCREMENT guarantees slots are never handed out twice.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS blobs (
          slot      INTEGER PRIMARY KEY AUTOINCREMENT,
          recipient TEXT    NOT NULL,
          seq       INTEGER NOT NULL,
          frame     TEXT    NOT NULL,
          stored_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS blobs_stored_at ON blobs(stored_at)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS vault (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.allow()) return fail(429, 'rate', { 'retry-after': '60' });

    const token = bearer(request);
    if (!token) return fail(401, 'token');

    const authorized = await this.authorize(token);
    if (!authorized) return fail(401, 'token');

    switch (request.method) {
      case 'PUT':
        return this.put(request);
      case 'GET':
        return this.get(new URL(request.url));
      case 'DELETE':
        this.sql.exec(`DELETE FROM blobs`);
        return json(200, { ok: true });
      default:
        return fail(405, 'method');
    }
  }

  /**
   * Trust on first use, which is the strongest thing available and stronger than it sounds.
   *
   * The bucket id and the write token are two different HKDF outputs of the same vault root
   * key. Knowing the id does not let you compute the token, and neither can be derived from
   * anything this server holds — so binding the first token seen and requiring it thereafter
   * means only a device holding the root key can read or write the bucket. The server still
   * cannot tell *which* device, or that two buckets share an owner.
   *
   * Only the SHA-256 of the token is stored. A dump of this database yields no write
   * capability to anything.
   */
  private async authorize(token: string): Promise<boolean> {
    const digest = await sha256Hex(token);
    const rows = this.sql.exec<{ v: string }>(`SELECT v FROM vault WHERE k = 'token'`).toArray();

    if (!rows.length) {
      this.sql.exec(`INSERT INTO vault (k, v) VALUES ('token', ?)`, digest);
      return true;
    }
    return constantTimeEqual(rows[0].v, digest);
  }

  private async put(request: Request): Promise<Response> {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'size');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'body');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'body');

    const row = body as Record<string, unknown>;
    if (typeof row.to !== 'string' || !TAG_PATTERN.test(row.to)) return fail(400, 'to');
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) {
      return fail(400, 'seq');
    }
    if (typeof row.frame !== 'string' || !row.frame.length) return fail(400, 'frame');
    if (row.frame.length > MAX_FRAME_CHARS) return fail(413, 'size');
    // Checked, not decoded. The server has no business looking inside a frame, and refusing
    // anything that is not base64url is the whole of the validation it is entitled to do.
    if (!/^[A-Za-z0-9_-]+$/.test(row.frame)) return fail(400, 'frame');

    const held = this.count();
    if (held >= MAX_BLOBS_PER_BUCKET) {
      // Deliberately not "drop the oldest". Silently discarding a blob a device is still
      // waiting for would look, from that device's side, exactly like a sync that worked —
      // and the whole design refuses to let a relay cause a silent divergence. A visible 429
      // sends the user to the sync screen, which tells them a device has been away too long.
      return fail(429, 'full', { 'retry-after': '3600' });
    }

    this.sql.exec(
      `INSERT INTO blobs (recipient, seq, frame, stored_at) VALUES (?, ?, ?, ?)`,
      row.to,
      row.seq,
      row.frame,
      Date.now(),
    );

    await this.scheduleSweep();
    return json(200, { ok: true });
  }

  private get(url: URL): Response {
    const after = integer(url.searchParams.get('after'), 0);
    const limit = Math.min(integer(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // One row over the page size, so `more` is a fact rather than a second query.
    const rows = this.sql
      .exec<BlobRow>(
        `SELECT slot, recipient, seq, frame FROM blobs WHERE slot > ? ORDER BY slot LIMIT ?`,
        after,
        limit + 1,
      )
      .toArray();

    const page = rows.slice(0, limit);
    return json(200, {
      blobs: page.map((blob) => ({
        slot: blob.slot,
        to: blob.recipient,
        seq: blob.seq,
        frame: blob.frame,
      })),
      more: rows.length > limit,
    });
  }

  /**
   * Deletes what has aged out, and re-arms only if something is still here.
   *
   * Retention is a privacy property before it is a cost one: a blob nobody collected is
   * ciphertext sitting on somebody else's disk, and the honest default is that it does not sit
   * there forever. A device that was away longer than the window re-receives the ops from the
   * sender's outbox, which never acknowledged them.
   */
  async alarm(): Promise<void> {
    this.sql.exec(`DELETE FROM blobs WHERE stored_at < ?`, Date.now() - this.retentionMs());
    if (this.count() > 0) {
      await this.state.storage.setAlarm(Date.now() + this.retentionMs());
    }
  }

  private async scheduleSweep(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) await this.state.storage.setAlarm(Date.now() + this.retentionMs());
  }

  private retentionMs(): number {
    const days = Number(this.env.RETENTION_DAYS);
    const safe = Number.isFinite(days) && days > 0 && days <= 365 ? days : DEFAULT_RETENTION_DAYS;
    return safe * 24 * 60 * 60 * 1000;
  }

  private count(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM blobs`).one().n;
  }

  private allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= 600;
  }
}

// ---------------------------------------------------------------------------
// Rendezvous — the signaling meeting point
// ---------------------------------------------------------------------------

/**
 * Two parties, one rotating id, and no memory.
 *
 * Everything crossing this socket is already sealed: the app runs its PSK-authenticated
 * handshake here *first*, and only then exchanges SDP and ICE candidates encrypted under the
 * keys that handshake derived. That ordering is what makes a hostile signaling server
 * harmless — it cannot swap a DTLS fingerprint it cannot read — and it is why this class can
 * be as simple as it is.
 *
 * Hibernating WebSockets rather than held references, so an idle rendezvous costs nothing and
 * there is no per-connection state to leak or to lose on eviction.
 */
export class RendezvousRoom {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return fail(426, 'upgrade');
    }

    // A rendezvous is a two-party meeting point by definition. A third socket is either a
    // mistake or somebody who guessed the id, and in both cases the right answer is to refuse
    // rather than to broadcast — the handshake would fail anyway, but not before both real
    // parties had wasted a transcript on it.
    if (this.state.getWebSockets().length >= 2) return fail(409, 'occupied');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.state.acceptWebSocket(server);
    await this.state.storage.setAlarm(Date.now() + RENDEZVOUS_TTL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Text only, and opaque. The app base64url-encodes its frames precisely so this server
    // never has to have an opinion about binary framing, and so a proxy in the middle cannot
    // mangle them.
    if (typeof message !== 'string') {
      ws.close(1003, 'text only');
      return;
    }
    if (message.length > MAX_SIGNAL_CHARS) {
      ws.close(1009, 'too large');
      return;
    }

    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.send(message);
      } catch {
        // The peer went away mid-relay. Its own close handler tidies up; there is nothing to
        // retry, because a signaling message that missed its window is superseded by the next
        // handshake attempt rather than resent.
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    // One party leaving ends the rendezvous. Leaving the other socket open would strand it
    // waiting for a reply that is never coming, and the app's own idle timeout is a slower,
    // worse version of this same signal.
    for (const other of this.state.getWebSockets()) {
      if (other === ws) continue;
      try {
        other.close(1000, 'peer left');
      } catch {
        // Already gone.
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, 'rendezvous expired');
      } catch {
        // Already gone.
      }
    }
    await this.state.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  // Bounded before it is hashed, so a 10 MB header is refused rather than digested.
  return token.length > 0 && token.length <= 512 ? token : null;
}

function integer(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Compares two hex digests without leaking where they first differ.
 *
 * Both operands are fixed-length SHA-256 hex, so the length check reveals nothing, and the
 * accumulate-then-compare shape means the loop runs the same number of iterations regardless
 * of the input. Timing an HTTP handler across the internet to recover a token byte-by-byte is
 * not a realistic attack — but writing `a === b` here and hoping is not a defensible reason
 * for it not to be one.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
