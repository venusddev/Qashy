# Qashy sync — threat model

Status: **written before any sync code**, per the process gate in `AGENTS.md`. Revise this document
first when the design changes; the code follows it, not the other way round.

Qashy stores finance data locally and sends it nowhere. Sync is the one deliberate exception, and it is
built so that adding it does not weaken that claim: the only parties that can read your data are devices
you personally paired, in person, with a short code you compared on both screens. Any server involved is
a blind pipe.

---

## 1. What we are protecting

| Asset | Sensitivity |
|---|---|
| Finance records (accounts, transactions, budgets, goals, rates) | High — a complete picture of someone's finances |
| Vault Root Key (VRK) and everything derived from it | Critical — grants read/write access to the whole vault, forever |
| Per-device Ed25519 / X25519 private keys | Critical — grants the ability to author history attributable to that device |
| Recovery phrase | Critical — **it is the vault** |
| Metadata: how many records exist, when you use the app, which devices you own | Medium — leaks habits and identity even when contents stay sealed |
| The user's IP address | Medium — the one thing end-to-end encryption cannot hide |

## 2. Who we are defending against

| Adversary | Capability assumed |
|---|---|
| The relay / signaling operator (including us) | Full read/write of everything stored and relayed; can drop, reorder, replay, or fabricate |
| A passive network observer | Sees all traffic, including TLS metadata and byte counts |
| An active on-path attacker | Can intercept and modify traffic during pairing and during sync |
| An opportunistic local attacker | Photographs or screenshots a pairing QR code |
| A thief | Physical possession of an unlocked or locked device |

## 3. Defences

| Threat | Defence | Where it lives |
|---|---|---|
| Malicious or compromised relay | The relay only ever holds AEAD ciphertext under a key it has never seen. Every op batch is Ed25519-signed by its author and hash-chained, so the relay cannot forge, reorder, or silently drop history without detection. | `src/sync/crypto/envelope.ts`, `src/sync/engine/apply.ts` |
| Passive observer | TLS on the outside, an independent end-to-end envelope on the inside. WebRTC's DTLS is **not** trusted alone — its fingerprints pass through signaling, so a hostile signaling server could substitute them. | `src/sync/transport/` |
| Active attacker during pairing | The pairing secret travels optically (QR), not over the network. The handshake is PSK-authenticated with that secret. | `src/sync/crypto/handshake.ts` |
| Photographed or relayed QR code | A 6-word Short Authentication String derived from the handshake transcript is shown on **both** screens and must be compared by a human. An attacker who raced the handshake produces a different SAS. The QR is single-use with a 90-second TTL. | `src/sync/crypto/sas.ts` |
| Lost or stolen device | Revoke it from the device roster; every peer then rejects its future ops. Rotating the vault key additionally removes its relay access. It keeps the plaintext it already had — see §4. | `sync_peers`, `/sync` |
| Replay or truncation of history | Per-device monotonic `seq` plus a `prevHash` chain. A gap, a rewind, or a fork is rejected loudly and surfaced, never silently merged. | `src/sync/engine/apply.ts` |
| Protocol downgrade | The protocol version is bound into the handshake transcript that both sides sign. An unknown major version refuses to connect. | `src/sync/crypto/handshake.ts` |
| Metadata leakage | Bucket and rendezvous ids are HKDF outputs; the rendezvous id rotates every 5 minutes, so an observer cannot link one vault across time. Blobs are padded to power-of-two size buckets so byte counts do not reveal "three transactions were added". Uploads are jittered. | `src/sync/transport/relay.ts` |
| IP exposure | Host ICE candidates are tried first, so LAN sync contacts no server at all. STUN is only reached for on failure. **No default TURN server is ever shipped** — TURN sees both endpoints and all traffic volume; it is user-supplied only, behind an explicit warning. | `src/sync/transport/webrtc-core.ts` |

## 4. What this does **not** defend against

State these in the UI and the README. Pretending otherwise would be worse than the limitation.

- **A compromised OS**, a rooted or jailbroken device, or malware with process-memory access.
- **The local database is not encrypted at rest by Qashy.** It is not today either; OS full-disk encryption
  is the boundary. Encrypting only the sync log while `records` stays plaintext would be theatre.
  Optional at-rest encryption is deliberately out of scope.
- **A compromised *paired* device.** There is no partial authorization in a single-user vault: a device you
  paired can read and write everything. Revocation limits future access only.
- **Global passive traffic analysis** by an adversary who can observe both endpoints at once.
- **Anyone who obtains the recovery phrase.** The recovery phrase *is* the vault.
- **Script execution inside the web origin.** Non-extractable key wrapping stops exfiltration of key
  *material*, but an attacker already running script in the origin can use the key in place. Mitigated by a
  strict CSP, no third-party scripts, no analytics, no remote code, and an empty `runtimeCaching`.

## 5. Cryptographic choices, and why

| Purpose | Primitive | Rationale |
|---|---|---|
| Content encryption | XChaCha20-Poly1305 (`@noble/ciphers`) | The 24-byte nonce makes random nonces safe by construction. AES-GCM's 12-byte nonce is risky when several devices generate nonces independently and cannot coordinate a counter — GCM nonce reuse is catastrophic and silent. One implementation across iOS, Android, and web also means one thing to test instead of three paths that can diverge. |
| Key agreement | X25519 (`@noble/curves`) | Standard, constant-time, audited. |
| Signatures | Ed25519 (`@noble/curves`) | Gives authenticity, attribution, and revocation that actually revokes. A shared symmetric key alone would let any holder forge history indistinguishably. |
| Hashing / KDF | SHA-256, HKDF (`@noble/hashes`) | Synchronous, so the op-chain hash can run inside a database transaction. `crypto.subtle.digest` is async and cannot. |
| Passphrase stretching | scrypt, N=2²⁰ (`@noble/hashes`) | Memory-hard; used for the encrypted backup file and the optional web keystore gate. |
| Recovery phrase | BIP39 24 words (`@scure/bip39`) | Well-understood, widely transcribable, with a checksum that catches transcription errors. |

All five packages are pure JS with no transitive dependencies, work identically on Hermes and in browsers,
and are **pinned to exact versions**. Never hand-roll a primitive; the only hand-written *construction* is
the handshake, and it carries its own known-answer and adversarial tests.

## 6. Key hierarchy

```
Vault Root Key (VRK) — 32 random bytes, created once on the first device.
│  Never transmitted except during an SAS-confirmed pairing handshake.
│  Stored only in platform secure storage.
│
├─ HKDF(VRK, "qashy/sync/v1/content")     → content key      (seals op batches)
├─ HKDF(VRK, "qashy/sync/v1/bucket")      → relay bucket id  (opaque to the relay)
├─ HKDF(VRK, "qashy/sync/v1/bucket-auth") → relay write capability token
├─ HKDF(VRK, "qashy/sync/v1/rendezvous" ‖ floor(unixSeconds / 300))
│                                         → rotating signaling rendezvous id
└─ HKDF(VRK, "qashy/sync/v1/backup")      → encrypted-backup key

Per device, generated locally; private halves never leave the device:
  Ed25519 keypair → identity and op signing
  X25519 keypair  → static key for the handshake
  deviceId = base32(SHA-256("qashy/sync/v1/device" ‖ ed25519Pub))[0..25]
```

Every HKDF label comes from the single table in `src/sync/crypto/labels.ts`. Ad-hoc label strings scattered
through a codebase are how domain-separation bugs happen.

### Key storage

| Platform | Mechanism |
|---|---|
| iOS / Android | `expo-secure-store` — Keychain / Android Keystore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. |
| Web | Raw key bytes in IndexedDB, wrapped by a **non-extractable `CryptoKey`** that is itself stored in IndexedDB. Optional "require a passphrase on this browser" gate (scrypt) so a stolen laptop with a logged-in profile does not surrender the vault. |

Sync configuration must **never** live in `AppSettings` — that entity replicates to peers, so a device's own
private state would be broadcast to every other device. It lives in a device-local `sync_meta` table, and key
material lives only in the keystore.

## 7. Pairing

Device **A** holds the vault. Device **B** is joining.

1. A generates an ephemeral X25519 keypair and a random 256-bit **pairing secret `PS`**, and renders a QR
   encoding `qashy-pair:1:<base32(PS)>:<deviceIdA>:<ephPubA>:<transport hint>`. Single use, 90-second TTL.
2. B scans it and now holds `PS`. Because `PS` crossed an optical channel, a network attacker does not have it.
3. Both run the handshake (§8) with `PS` as the pre-shared key.
4. **Both screens display the same 6-word SAS.** The user compares them and taps "They match" on both. A
   prominent "They don't match" aborts and blacklists the attempt. *This is what makes a leaked QR
   survivable:* an attacker who photographed the QR and raced the handshake produces a different SAS, and the
   human sees two different values.
5. Only after both confirmations does A seal and send the VRK plus the signed device roster.
6. B returns its signed public keys. A adds B to the roster and broadcasts the updated, signed roster.
7. Both wipe `PS` and the ephemeral keys.

**Camera-less devices** reverse the direction: the new device displays the QR and the phone scans it. A
**manual code paste** path exists as a documented fallback for desktops, and doubles as the hook that makes
pairing testable in CI, which has no camera. It is a real feature, not a test bypass.

## 8. Session handshake

PSK-authenticated ephemeral ECDH with a signed transcript — Noise_KKpsk0 semantics, assembled explicitly.
Also used for every reconnect, with the VRK in place of `PS`.

1. Each side sends `{ version, deviceId, ephemeralX25519Pub, 32-byte nonce }`.
2. `ss = X25519(ephPrivSelf, ephPubPeer)`
3. `transcript = SHA-256(version ‖ sortedByDeviceId(msgA, msgB))`
4. `sessionKeys = HKDF(ikm = ss ‖ PSK, salt = transcript, info = "qashy/sync/v1/session")` → **two
   directional keys** `k_A→B` and `k_B→A`, so the two sides can never collide on (key, nonce).
5. Each side sends `Ed25519.sign(identityPriv, "qashy/sync/v1/auth" ‖ transcript)`, verified against the
   roster entry for that `deviceId`. During pairing there is no roster yet, so the signature binds the keys
   being exchanged to the transcript instead.
6. The SAS is derived from the same transcript.

Mixing the PSK into the HKDF gives confidentiality against non-members; the ephemeral ECDH gives forward
secrecy; the signed transcript defeats MITM; binding `version` into the transcript defeats downgrade.

**Ordering is a security requirement.** Over WebRTC, this handshake runs on the signaling channel *first*.
Only then are SDP and ICE candidates exchanged, encrypted under the derived session keys. That is what stops
a hostile signaling server from substituting DTLS fingerprints. Op batches are then encrypted *again* inside
the data channel, so DTLS is defence in depth rather than the only defence.

## 9. The server

One tiny stateless service. Three endpoints:

- `GET /health` — a static `{ ok, version }`. No bucket id, no auth, nothing correlatable. Polled only on app
  foreground and on explicit user request, never on a timer, because a scheduled ping is itself a traffic
  pattern.
- `GET/WS /rendezvous/:rotatingId` — relays opaque handshake blobs between two parties presenting the same
  rotating id. Keeps nothing.
- `PUT/GET/DELETE /bucket/:bucketId` — an encrypted drop-box. Padded ciphertext, size- and rate-capped,
  auto-expiring.

The server sees an opaque 32-byte id, padded ciphertext, and an IP address. It cannot see who you are, what
changed, how many records you have, or link one day's rendezvous to another's. It is replaceable or blankable
in settings, and sync is off until you turn it on.

## 10. Process rules

These are the rules that keep the implementation honest; they are mirrored as invariants in `AGENTS.md`.

1. This document is committed and reviewed **before** crypto code is written.
2. Crypto is quarantined in `src/sync/crypto/`; ESLint forbids `@noble/*` and `@scure/*` imports elsewhere.
3. Branded types for key material, so a signing key cannot be passed where a content key belongs.
4. Known-answer tests against RFC 8439, RFC 7748, RFC 8032, RFC 5869, RFC 7914, and BIP39 — these catch a
   swapped or subverted dependency.
5. Golden wire vectors committed as fixtures, so a refactor cannot silently change the wire format.
6. The adversarial test suite is a deliverable, not an afterthought.
7. **Fail closed everywhere.** Any signature failure, roster miss, chain break, HLC sanity failure, or
   invariant violation rejects the *entire* batch — never a partial apply. Crypto errors are never swallowed
   by a generic `catch`.
8. No secrets in logs, URLs, clipboards, or the service-worker cache. `no-console` is enforced across
   `src/sync/`.
9. Supply chain: exact pinned versions, committed lockfile, `npm ci` in CI. Never `npm audit fix --force`.
10. Zeroize key buffers after use on a best-effort basis, acknowledging in a comment that JS cannot guarantee it.
11. Sync stays behind a feature flag, off, until a security review of `src/sync/crypto/` and
    `src/sync/engine/apply.ts` has passed.
