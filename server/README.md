# Qashy relay

A blind relay for Qashy sync. It is ~450 lines with no dependencies, and it is designed so
that reading it in full is a realistic thing to ask of you before you deploy it.

It does three things:

| Route | What it does |
| --- | --- |
| `GET /health` | Returns `{ "ok": true, "version": 1 }`. No id, no auth, nothing correlatable. This is what the app's **More → Sync** relay-status row asks. |
| `GET /rendezvous/:id` (WebSocket) | Relays opaque text between exactly two parties that arrived at the same rotating id. Stores nothing. |
| `PUT`/`GET`/`DELETE` `/bucket/:id` | A drop-box of sealed, padded frames addressed to a blinded route tag. |

## What this server can see

Exhaustively: an opaque 52-character identifier, a 16-character route tag, a small integer, some
padded base64url ciphertext, and an IP address.

It cannot see who you are, what changed, how many records you have, or that two buckets belong
to the same person. Every identifier is an HKDF output of a vault root key the server has never
held and cannot derive.

## What it can still do, and why that is survivable

It can drop a blob, reorder a page, replay one, or refuse service. None of those corrupt a
vault: every frame is AEAD-sealed under a key the server has never seen, every batch is
Ed25519-signed by its sender, and every op is separately signed and hash-chained to its author's
previous op. A gap, a rewind, or a fork is rejected by the receiving device rather than merged.

**A hostile relay is a denial of service. It is not a disclosure and it is not a corruption.**
That is the property the app's threat model claims, and it is the reason this server is allowed
to be this simple.

The one thing end-to-end encryption cannot hide is your IP address, which is why the app tries
a direct WebRTC connection first and only falls back to this. Two devices on the same Wi-Fi
never contact this server for data at all.

## Deploying it

You need a Cloudflare account. The free plan is enough — Durable Objects with the SQLite
storage backend are included in it, and personal-scale sync is a rounding error against the
free limits.

```bash
cd server
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints a URL like `https://qashy-relay.<your-subdomain>.workers.dev`. That is
the value you paste into **More → Sync → Advanced → Relay address** in the app, and the one to
hand back if you want it baked in as the shipped default.

Verify it before trusting it:

```bash
curl https://qashy-relay.<your-subdomain>.workers.dev/health
# {"ok":true,"version":1}
```

There is **no KV namespace and no R2 bucket to create.** Storage lives inside the Durable
Objects themselves, which is both simpler to operate and stricter about ordering — the client's
cursor is a monotonic integer, and allocating monotonic integers needs serialisation that KV
cannot provide.

### Running it locally

```bash
npm run dev        # http://127.0.0.1:8787
```

The app accepts `http://localhost` and `http://127.0.0.1` relay addresses without TLS, and
refuses plaintext `http://` anywhere else. That exception exists for exactly this.

### A custom domain

Optional and not recommended for privacy: a `*.workers.dev` subdomain is less identifying than
`sync.your-name.com`. If you want one anyway, add a `routes` entry to `wrangler.toml` per the
Cloudflare docs.

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Retention window for undelivered blobs | `RETENTION_DAYS` in `wrangler.toml` | 14 days |
| Request logging | `[observability]` in `wrangler.toml` | **off** |
| Aggregate bucket requests | `REQUEST_RATE_LIMITER` in `wrangler.toml` | 120/minute per Cloudflare location |

Shortening retention is safe. A device that was away longer simply receives the ops again from
the sender's outbox, which never got an acknowledgement for them — nothing is lost by expiring
a blob, something is only delayed.

Leaving observability off is deliberate and load-bearing. Request logs carry IP addresses and
bucket ids, and those two together are exactly the correlation the rest of this design exists
to prevent. If you turn it on to debug a deploy, turn it back off.

## Limits, and what happens when one is hit

| Limit | Value | Response |
| --- | --- | --- |
| Frame size | 1 400 000 base64url characters | `413` → the app shows "too large"; direct sync unaffected |
| Request body | 2 MiB, counted while streaming | `413` before a Durable Object is created |
| Blobs per bucket | 5 000 | `429` → the app shows a relay error and names the device that has been away |
| Page size | 500 (default 100) | silently clamped |
| Requests across bucket ids | 120/minute per Cloudflare location | `429` |
| Requests per bucket | ~600/minute additional coarse brake | `429` |
| Signaling message | 64 KiB | socket closed with `1009` |
| Parties per rendezvous | 2 | `409` |

A full bucket is refused rather than trimmed. Silently dropping the oldest blob would look, from
the waiting device's side, exactly like a sync that worked — and nothing in this design lets a
relay cause a silent divergence.

### Rate limiting

The Worker rate-limit binding is checked before a Durable Object is named or created. It uses
one constant key, so an attacker cannot obtain a new quota by changing bucket ids or tokens,
and the application stores no IP address. Cloudflare applies this limit per location and
documents the result as eventually consistent, so the per-bucket in-memory counter remains as
an additional coarse brake. A public, high-traffic deployment can also add a Cloudflare WAF
rule, but that is optional hardening rather than the only protection.

## Authorization

Both the bucket id and the write token are HKDF outputs of the same vault root key, under
different labels. Knowing an id does not let you compute its token, and neither can be derived
from anything this server holds.

The bucket therefore binds the **first token it ever sees** — storing only its SHA-256 — and
requires a constant-time match for every request afterwards. Only a device holding the vault
root key can read or write. A dump of this database yields no write capability to anything.

## Self-hosting elsewhere

Nothing here is Cloudflare-specific in spirit; the only platform dependencies are Durable
Objects (for serialised slot allocation and hibernating WebSockets) and their SQLite storage. A
port to Deno Deploy, Fly, or a small VPS needs an equivalent of those two things: a
single-writer per bucket, and a WebSocket pair per rendezvous. The wire contract it has to
satisfy is:

```
GET    /health                              → 200 {"ok":true,"version":1}
GET    /rendezvous/{id}   (Upgrade)         → 101, relays text between two parties
PUT    /bucket/{id}       Bearer {token}    ← {"to":"…","seq":0,"frame":"base64url"}
GET    /bucket/{id}?after={slot}&limit={n}  → 200 {"blobs":[{"slot","to","seq","frame"}],"more":bool}
DELETE /bucket/{id}       Bearer {token}    → 200 {"ok":true}
```

Slots must be monotonically increasing and never reused, including after a `DELETE`. A client
holding a cursor past a reused slot would never see the blob that took it.
