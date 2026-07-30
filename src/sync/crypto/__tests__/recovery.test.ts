import { createDeviceIdentity, createVaultRootKey } from '@/sync/crypto/keys';
import { fromHex, toHex, utf8Bytes } from '@/sync/crypto/primitives';
import {
  RECOVERY_WORD_COUNT,
  createPassphraseBackup,
  createVaultBundle,
  createVaultKeyBackup,
  isValidRecoveryPhrase,
  openPassphraseBackup,
  openVaultBundle,
  openVaultKeyBackup,
  readBackupKind,
  recoveryPhraseToVaultKey,
  vaultKeyToRecoveryPhrase,
} from '@/sync/crypto/recovery';
import { SyncCryptoError, brand, type VaultRootKey } from '@/sync/crypto/types';

describe('the recovery phrase', () => {
  it('matches the published BIP39 vectors', () => {
    // Official BIP39 test vectors for 256-bit entropy. These pin the wordlist and the
    // checksum construction: a phrase written down today must still restore in ten years.
    expect(vaultKeyToRecoveryPhrase(brand<VaultRootKey>(new Uint8Array(32)))).toBe(
      `${'abandon '.repeat(23)}art`,
    );
    expect(vaultKeyToRecoveryPhrase(brand<VaultRootKey>(new Uint8Array(32).fill(0xff)))).toBe(
      `${'zoo '.repeat(23)}vote`,
    );
  });

  it('is 24 words', () => {
    expect(vaultKeyToRecoveryPhrase(createVaultRootKey()).split(' ')).toHaveLength(
      RECOVERY_WORD_COUNT,
    );
  });

  it('round-trips the vault key exactly', () => {
    const vault = createVaultRootKey();
    expect(toHex(recoveryPhraseToVaultKey(vaultKeyToRecoveryPhrase(vault)))).toBe(toHex(vault));
  });

  it('tolerates how a person actually types it back in', () => {
    const vault = createVaultRootKey();
    const phrase = vaultKeyToRecoveryPhrase(vault);
    const messy = `  ${phrase.toUpperCase().split(' ').join('   ')}\n`;
    expect(toHex(recoveryPhraseToVaultKey(messy))).toBe(toHex(vault));
    expect(isValidRecoveryPhrase(messy)).toBe(true);
  });

  it('rejects one mistyped word instead of restoring a different, useless vault', () => {
    // This is the whole reason for BIP39 over a hex dump. Without the checksum, a phrase
    // transcribed wrong would reconstruct a valid-looking key that decrypts nothing, and
    // the user would have no way to tell which word they got wrong.
    // Built from the all-zeros vector rather than a random key so the assertion is a fixed
    // fact and not a 1-in-256 gamble on the checksum happening to catch it.
    const phrase = `${'abandon '.repeat(23)}art`.split(' ');
    phrase[5] = 'zoo';
    expect(() => recoveryPhraseToVaultKey(phrase.join(' '))).toThrow(/mistyped or out-of-order/);
    expect(isValidRecoveryPhrase(phrase.join(' '))).toBe(false);
  });

  it('rejects words that are not in the list, and phrases of the wrong length', () => {
    expect(() => recoveryPhraseToVaultKey('not actually a recovery phrase at all')).toThrow(
      SyncCryptoError,
    );
    // A valid 12-word phrase carries only 128 bits — not a Qashy vault key.
    expect(() =>
      recoveryPhraseToVaultKey('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
    ).toThrow(/24 words/);
  });
});

describe('the passphrase-protected backup', () => {
  // Deliberately weak parameters so the suite stays fast. The file records what was used,
  // so a backup written with production parameters still opens — that is what the header
  // is for.
  const params = { N: 4096, r: 8, p: 1 };
  const payload = utf8Bytes(JSON.stringify({ vault: 'everything', accounts: 3 }));

  it('round-trips under the right passphrase', () => {
    const file = createPassphraseBackup('correct horse battery', payload, params);
    expect(openPassphraseBackup('correct horse battery', file)).toEqual(payload);
  });

  it('salts every backup, so two backups of the same data look unrelated', () => {
    const one = createPassphraseBackup('correct horse battery', payload, params);
    const two = createPassphraseBackup('correct horse battery', payload, params);
    expect(toHex(one)).not.toBe(toHex(two));
  });

  it('leads with the likely cause on a wrong passphrase', () => {
    const file = createPassphraseBackup('correct horse battery', payload, params);
    expect(() => openPassphraseBackup('correct horse bettery', file)).toThrow(
      /Wrong passphrase, or the backup file is damaged/,
    );
  });

  it('rejects a tampered file', () => {
    const file = createPassphraseBackup('correct horse battery', payload, params);
    file[file.length - 5] ^= 0x01;
    expect(() => openPassphraseBackup('correct horse battery', file)).toThrow(SyncCryptoError);
  });

  it('refuses a passphrase short enough to be guessed', () => {
    expect(() => createPassphraseBackup('too-short', payload, params)).toThrow(
      /at least 12 characters/,
    );
  });

  it('rejects a file that is not a Qashy backup', () => {
    expect(() => openPassphraseBackup('correct horse battery', new Uint8Array(10))).toThrow(
      /not a Qashy backup/,
    );
    const file = createPassphraseBackup('correct horse battery', payload, params);
    file[0] ^= 0xff;
    expect(() => openPassphraseBackup('correct horse battery', file)).toThrow(/not a Qashy backup/);
  });

  it('rejects a backup written by a newer format', () => {
    const file = createPassphraseBackup('correct horse battery', payload, params);
    file[4] = 2;
    expect(() => openPassphraseBackup('correct horse battery', file)).toThrow(/newer version/);
  });

  describe('a hostile header', () => {
    const withParams = (over: Partial<{ N: number; r: number; p: number }>) => {
      const file = createPassphraseBackup('correct horse battery', payload, params);
      const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
      view.setUint32(5, over.N ?? params.N, false);
      view.setUint32(9, over.r ?? params.r, false);
      view.setUint32(13, over.p ?? params.p, false);
      return file;
    };

    it('refuses aggregate memory above the mobile-safe ceiling', () => {
      // The header is attacker-controlled input on any file that arrives from outside. Left
      // unbounded it is a denial of service that the victim's own device carries out.
      expect(() =>
        openPassphraseBackup('correct horse battery', withParams({ N: 2 ** 17 })),
      ).toThrow(
        /unreasonable amount of work/,
      );
    });

    it('refuses CPU amplification hidden in the parallelization field', () => {
      expect(() =>
        openPassphraseBackup(
          'correct horse battery',
          withParams({ N: 2 ** 16, r: 1, p: 5 }),
        ),
      ).toThrow(/unreasonable amount of work/);
    });

    it('refuses parameters too weak to have protected anything', () => {
      expect(() =>
        openPassphraseBackup('correct horse battery', withParams({ N: 1024 })),
      ).toThrow(/4096/);
    });
  });
});

describe('the vault-keyed bundle', () => {
  const vault = createVaultRootKey();
  const sender = createDeviceIdentity().deviceId;
  const payload = utf8Bytes('a hand-carried batch of ops');

  it('round-trips between devices that already share the vault', () => {
    const bundle = createVaultBundle(vault, sender, 1, 7, payload);
    expect(openVaultBundle(vault, sender, 1, 7, bundle)).toEqual(payload);
  });

  it('does not open under a different vault', () => {
    const bundle = createVaultBundle(vault, sender, 1, 7, payload);
    expect(() => openVaultBundle(createVaultRootKey(), sender, 1, 7, bundle)).toThrow(
      SyncCryptoError,
    );
  });

  it('is bound to the sender, epoch, and sequence it was written for', () => {
    const bundle = createVaultBundle(vault, sender, 1, 7, payload);
    expect(() => openVaultBundle(vault, 'SOMEONEELSE', 1, 7, bundle)).toThrow(SyncCryptoError);
    expect(() => openVaultBundle(vault, sender, 2, 7, bundle)).toThrow(SyncCryptoError);
    expect(() => openVaultBundle(vault, sender, 1, 8, bundle)).toThrow(SyncCryptoError);
  });

  it('is not interchangeable with a passphrase backup', () => {
    // Different purpose byte, different key. A bundle handed to the backup reader must fail
    // rather than half-parse: the two files carry the same data under very different
    // assumptions about who can read them.
    const bundle = createVaultBundle(vault, sender, 1, 7, payload);
    expect(() => openPassphraseBackup('correct horse battery', bundle)).toThrow(
      /not a Qashy backup/,
    );
  });
});

describe('the vault-keyed backup file', () => {
  const vault = createVaultRootKey();
  const payload = utf8Bytes(JSON.stringify({ records: 412, ops: 900 }));

  it('round-trips under the key it was sealed with', () => {
    expect(openVaultKeyBackup(vault, createVaultKeyBackup(vault, payload))).toEqual(payload);
  });

  it('opens under a key rebuilt from the phrase, which is the whole point of it', () => {
    // The one claim this variant exists to make: twenty-four words on paper, an archive on a
    // drive, no surviving device — and the data comes back. If this fails, the recovery screen
    // is promising something the app cannot do.
    const file = createVaultKeyBackup(vault, payload);
    expect(openVaultKeyBackup(recoveryPhraseToVaultKey(vaultKeyToRecoveryPhrase(vault)), file)).toEqual(
      payload,
    );
  });

  it('says the phrase is the wrong one rather than "damaged" on a different vault', () => {
    // The likely mistake is a phrase from another vault, not a typo — a typo dies on the BIP39
    // checksum long before it reaches the AEAD — so the message has to name that cause.
    const file = createVaultKeyBackup(vault, payload);
    expect(() => openVaultKeyBackup(createVaultRootKey(), file)).toThrow(
      /recovery phrase does not match this backup/,
    );
  });

  it('rejects a tampered file rather than returning part of it', () => {
    const file = createVaultKeyBackup(vault, payload);
    file[file.length - 3] ^= 0x01;
    expect(() => openVaultKeyBackup(vault, file)).toThrow(SyncCryptoError);
  });

  it('rejects a backup written by a newer format', () => {
    const file = createVaultKeyBackup(vault, payload);
    file[4] = 2;
    expect(() => openVaultKeyBackup(vault, file)).toThrow(/newer version/);
  });

  it('is not interchangeable with the passphrase variant in either direction', () => {
    // Both carry the same archive; only one of them is safe to hand to someone else. Reading
    // one as the other must fail on the magic, not decrypt under a key that happens to work.
    const keyed = createVaultKeyBackup(vault, payload);
    const guarded = createPassphraseBackup('correct horse battery', payload, { N: 4096, r: 8, p: 1 });
    expect(() => openPassphraseBackup('correct horse battery', keyed)).toThrow(/not a Qashy backup/);
    expect(() => openVaultKeyBackup(vault, guarded)).toThrow(/not a Qashy backup/);
  });
});

describe('reading which secret a file wants', () => {
  const payload = utf8Bytes('archive');

  it('tells the two backups apart from their first bytes', () => {
    // Read before anything is typed. Prompting for a passphrase in front of a phrase-locked
    // archive is a dead end the user has no way to diagnose.
    expect(readBackupKind(createVaultKeyBackup(createVaultRootKey(), payload))).toBe('vaultKey');
    expect(
      readBackupKind(createPassphraseBackup('correct horse battery', payload, { N: 4096, r: 8, p: 1 })),
    ).toBe('passphrase');
  });

  it('returns null for anything that is not a Qashy backup', () => {
    expect(readBackupKind(new Uint8Array(0))).toBeNull();
    // Shorter than the header. A reader that indexed past the end would read `undefined` and
    // match nothing by luck rather than by check.
    expect(readBackupKind(new Uint8Array([0x51, 0x53]))).toBeNull();
    expect(readBackupKind(utf8Bytes('this is a CSV export, actually'))).toBeNull();
  });
});

describe('a vault key restored from a phrase', () => {
  it('decrypts what the original key sealed', () => {
    // The end-to-end promise of recovery: every device gone, one phrase left, data back.
    const vault = createVaultRootKey();
    const bundle = createVaultBundle(vault, 'ORIGINALDEVICE', 0, 0, fromHex('deadbeef'));
    const restored = recoveryPhraseToVaultKey(vaultKeyToRecoveryPhrase(vault));
    expect(toHex(openVaultBundle(restored, 'ORIGINALDEVICE', 0, 0, bundle))).toBe('deadbeef');
  });
});
