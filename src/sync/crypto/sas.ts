/**
 * The Short Authentication String — six words, shown on both screens, compared by a human.
 *
 * This is the single control that makes a leaked pairing QR survivable. Everything else in
 * pairing assumes the QR stayed private; the SAS assumes it did not. An attacker who
 * photographed the code and raced the handshake ends up in a *different* session with a
 * *different* transcript, so the two screens show different words and the person stops.
 *
 * It follows that the SAS must be genuinely awkward to skip. The UI must not pre-select
 * "they match", must not auto-advance, and must give "they don't match" equal prominence.
 * A confirmation the user learns to tap through is worth nothing.
 */

import { wordlist } from '@scure/bip39/wordlists/english.js';

import { LABELS } from '@/sync/crypto/labels';
import { sha256, utf8Bytes } from '@/sync/crypto/primitives';
import type { TranscriptHash } from '@/sync/crypto/types';

/** Six words from a 2048-word list is 66 bits — far beyond what an online racing attack can search. */
export const SAS_WORD_COUNT = 6;

const BITS_PER_WORD = 11;

/**
 * The BIP39 English list, reused deliberately. It is chosen so that no two words share a
 * four-letter prefix and none are homophones, which is exactly the property needed when
 * two people read words to each other over a phone call.
 */
const WORDS = wordlist;

export const deriveSas = (transcript: TranscriptHash): string[] => {
  const digest = sha256(utf8Bytes(LABELS.sas), transcript);
  const words: string[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let index = 0;
  while (words.length < SAS_WORD_COUNT) {
    // The digest is 256 bits and we consume 66, so this never runs dry.
    bitBuffer = (bitBuffer << 8) | digest[index];
    bitCount += 8;
    index += 1;
    if (bitCount >= BITS_PER_WORD) {
      const shift = bitCount - BITS_PER_WORD;
      words.push(WORDS[(bitBuffer >> shift) & 0x7ff]);
      bitBuffer &= (1 << shift) - 1;
      bitCount = shift;
    }
  }
  return words;
};

/**
 * Compares two SAS renderings.
 *
 * Not constant-time, and deliberately so: both values are already displayed on a screen,
 * so there is no secret left to leak through timing. This exists for tests and for the
 * "paste the code from the other device" fallback, not for the primary flow — in the
 * primary flow the comparison is done by a person, which is the entire point.
 */
export const sasMatches = (a: readonly string[], b: readonly string[]) =>
  a.length === SAS_WORD_COUNT && a.length === b.length && a.every((word, index) => word === b[index]);
