import { SAS_WORD_COUNT, deriveSas, sasMatches } from '@/sync/crypto/sas';
import { fromHex, sha256, utf8Bytes } from '@/sync/crypto/primitives';
import { brand, type TranscriptHash } from '@/sync/crypto/types';

const transcript = (seed: string) => brand<TranscriptHash>(sha256(utf8Bytes(seed)));

describe('the short authentication string', () => {
  it('is six words from the BIP39 list', () => {
    const words = deriveSas(transcript('a'));
    expect(words).toHaveLength(SAS_WORD_COUNT);
    for (const word of words) expect(word).toMatch(/^[a-z]{3,8}$/);
  });

  it('is a pure function of the transcript', () => {
    expect(deriveSas(transcript('a'))).toEqual(deriveSas(transcript('a')));
  });

  it('changes completely when the transcript changes at all', () => {
    // This is the property the whole control rests on: a MITM ends up in a different
    // session, so its transcript differs, so the two screens disagree.
    const one = deriveSas(brand<TranscriptHash>(fromHex('00'.repeat(32))));
    const two = deriveSas(brand<TranscriptHash>(fromHex(`${'00'.repeat(31)}01`)));
    expect(one).not.toEqual(two);
    expect(one.filter((word, index) => word === two[index])).toHaveLength(0);
  });

  it('spreads across the wordlist rather than clustering', () => {
    // A bit-extraction bug — an off-by-one shift, a mask of the wrong width — usually shows
    // up as a small set of repeated words rather than as an outright failure.
    // 1200 draws from a 2048-word list touch ~907 distinct words if the extraction is
    // uniform. The bound is loose because the point is to catch an extractor that reaches
    // a few dozen words, not to assert a coupon-collector constant.
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      for (const word of deriveSas(transcript(`seed-${index}`))) seen.add(word);
    }
    expect(seen.size).toBeGreaterThan(800);
  });

  it('compares two renderings exactly', () => {
    const words = deriveSas(transcript('a'));
    expect(sasMatches(words, [...words])).toBe(true);
    expect(sasMatches(words, [...words.slice(0, 5), 'zoo'])).toBe(false);
    expect(sasMatches(words, words.slice(0, 5))).toBe(false);
    expect(sasMatches([], [])).toBe(false);
  });
});
