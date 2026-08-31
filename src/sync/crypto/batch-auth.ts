/**
 * Sender authentication for a sync batch.
 *
 * The envelope is encrypted with a vault-wide key, so every member can create one. That is
 * useful for peer-to-peer forwarding but insufficient to prove which member assembled a
 * batch: a removed device still holding the old vault key could otherwise claim to be an
 * active peer. This construction signs the complete canonical batch payload with the
 * sender's Ed25519 identity key.
 */

import { LABELS } from '@/sync/crypto/labels';
import { fromHex, sign, toHex, utf8Bytes, verify } from '@/sync/crypto/primitives';
import type { SigningPublicKey, SigningSecretKey } from '@/sync/crypto/types';
import { canonicalJson } from '@/utils/canonical-json';

const authenticatedBytes = (payload: unknown) =>
  utf8Bytes(`${LABELS.batchAuth}:${canonicalJson(payload)}`);

export const signBatchPayload = (payload: unknown, secretKey: SigningSecretKey): string =>
  toHex(sign(authenticatedBytes(payload), secretKey));

export function verifyBatchPayload(
  payload: unknown,
  signature: string,
  publicKey: SigningPublicKey,
): boolean {
  try {
    return verify(fromHex(signature), authenticatedBytes(payload), publicKey);
  } catch {
    return false;
  }
}
