/**
 * Branded key material.
 *
 * Every key in this system is 32 bytes, so without brands the compiler would happily
 * let a signing key be passed where a content key belongs — a mistake that produces no
 * type error, no runtime error, and a catastrophic loss of key separation. The brands
 * are erased at runtime; they exist purely so that swap is a compile error.
 *
 * Nothing outside `src/sync/crypto/` should construct these. Use the derivation
 * functions in `keys.ts`.
 */

declare const keyBrand: unique symbol;

type Branded<Name extends string> = Uint8Array & { readonly [keyBrand]: Name };

/** 32 random bytes. The root of everything, and the only thing pairing transfers. */
export type VaultRootKey = Branded<'VaultRootKey'>;

/** Seals op batches. Derived from the VRK; never itself transmitted. */
export type ContentKey = Branded<'ContentKey'>;

/** One direction of a session. `k_A→B` and `k_B→A` are distinct so the two sides can never collide on (key, nonce). */
export type SessionKey = Branded<'SessionKey'>;

/** Seals the passphrase-protected backup file. */
export type BackupKey = Branded<'BackupKey'>;

/** The short-lived secret that crosses the optical channel during pairing. */
export type PairingSecret = Branded<'PairingSecret'>;

/** Write capability presented to the relay. Proves nothing about identity. */
export type BucketToken = Branded<'BucketToken'>;

export type SigningSecretKey = Branded<'SigningSecretKey'>;
export type SigningPublicKey = Branded<'SigningPublicKey'>;
export type AgreementSecretKey = Branded<'AgreementSecretKey'>;
export type AgreementPublicKey = Branded<'AgreementPublicKey'>;

/** SHA-256 over the ordered handshake messages. Both the MITM defence and the SAS input. */
export type TranscriptHash = Branded<'TranscriptHash'>;

/**
 * Anything the AEAD may be keyed with. Deliberately a closed union rather than
 * `Uint8Array`: it admits the three keys that legitimately seal data and rejects the
 * signing and agreement keys, which is the confusion worth catching at compile time.
 */
export type SealingKey = ContentKey | SessionKey | BackupKey;

export interface SigningKeyPair {
  readonly publicKey: SigningPublicKey;
  readonly secretKey: SigningSecretKey;
}

export interface AgreementKeyPair {
  readonly publicKey: AgreementPublicKey;
  readonly secretKey: AgreementSecretKey;
}

/**
 * Applies a brand. Only `keys.ts`, `handshake.ts`, and `recovery.ts` may call this, and
 * only on bytes they just derived or generated — never on bytes that arrived over a
 * transport, which is exactly the confusion the brands exist to prevent.
 */
export const brand = <T extends Uint8Array>(bytes: Uint8Array) => bytes as T;

/** Thrown by everything in this directory. Never swallowed by a generic `catch`. */
export class SyncCryptoError extends Error {
  constructor(
    message: string,
    readonly code: SyncCryptoErrorCode,
  ) {
    super(message);
    this.name = 'SyncCryptoError';
  }
}

export type SyncCryptoErrorCode =
  | 'badLength'
  | 'badFormat'
  | 'badVersion'
  | 'badSignature'
  | 'badTag'
  | 'badIdentity'
  | 'badPassphrase'
  | 'badMnemonic'
  | 'weakKey';
