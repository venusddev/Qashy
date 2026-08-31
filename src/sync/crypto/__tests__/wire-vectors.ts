/**
 * Frozen wire vectors.
 *
 * Every value below was produced by this codebase and then committed. They are not derived
 * from a standard, so they prove nothing about the primitives — `primitives.test.ts` does
 * that against the RFCs. What they pin is the *composition*: the HKDF labels, the frame
 * header, the associated-data layout, the padding buckets, the transcript ordering, the
 * SAS extraction, and the backup file header.
 *
 * The point is that all of those are silent. Change a label string, reorder a field in the
 * associated data, or alter a padding bucket, and nothing throws at build time — devices
 * simply stop understanding each other, and the symptom is "sync doesn't work" long after
 * the change that caused it. These vectors turn every one of those into a failing test.
 *
 * **Never regenerate these to make a test pass.** A failure here means the wire format
 * changed. If that is intentional, it is a protocol version bump (`PROTOCOL_VERSION`) with
 * a migration story for already-paired devices — not an edit to this file.
 */

export const WIRE_VECTORS = {
  /** Arbitrary but fixed. Chosen once; never a real vault. */
  vaultRootKey: '9f2c4a1d0e6b8375c1a9e4f70d2b6853ae17c9048f3d62b5710ecaf4839d6b21',
  pairingSecret: '07'.repeat(32),

  alice: {
    signingSecret: '01'.repeat(32),
    agreementSecret: '11'.repeat(32),
    ephemeralSecret: '03'.repeat(32),
    helloNonce: '05'.repeat(32),
    deviceId: 'B55VRAHZV5OLSRTLCPXMVJOV5E',
  },
  bob: {
    signingSecret: '02'.repeat(32),
    agreementSecret: '12'.repeat(32),
    ephemeralSecret: '04'.repeat(32),
    helloNonce: '06'.repeat(32),
    deviceId: 'LT5HMR6GPNRFIAHY5OOTG7LSQ5',
  },

  derived: {
    contentKey: 'c9287afd5c3e5dcc135c0d3c69e4153575fb6418457fee978c7f6419f83ec77e',
    backupKey: '1f443172781b73893bac0b085fbe28b0c741f31bcad237a7908582afebe54b31',
    bucketToken: '178e48ea2391afd1611278f5dcac51fc5b09df9ded55e1ca94c4018cd82bae09',
    bucketId: 'UBNGZSOH5LPEPT3HXQJ3EGBMGT3KAZWPX2IZDXZ3DS4FSIRCZNPQ',
    rendezvousWindow: 6_000_000,
    rendezvousId: 'CD4XMQXEVOXOXBCHM3WZSTMG2ISHJJNY76TGGROVWPCDNXTWKKZQ',
    recoveryPhrase:
      'palace girl mansion broom return road allow develop warfare harsh sure point thumb tonight banana tray glance process dry nominee else solid prosper coach',
  },

  handshake: {
    transcript: 'f88d906dec987e0452a361c5d9d3bf16b2c0b2857a2223a06d5ffb50bd8ec523',
    sas: ['scout', 'want', 'travel', 'clump', 'jump', 'next'],
    /** Alice's id sorts lower than Bob's, so this is the `lowToHigh` half. */
    aliceSendKey: '83497ae763358c525808de0bf7fa258928486beaa050da1038e0b69b34d16b36',
    aliceReceiveKey: 'd114f9f4d6230bf59360816b6d90ef3d19add6bfb15c7972af979131240d6add',
    /** Ed25519 is deterministic, so these are stable vectors rather than samples. */
    aliceAuth:
      '5f985760d9b1ea433460eec0c7c21c328eaeb7905f3d0fc2838262058e4a6a63' +
      '5129136e5d9b792a94997002fdf71c37bf5d50e089a496f463d256c640fc8d03',
    bobAuth:
      '6714c9397cdc65867edc956878ab459b7a9506440e4e9073fb817a0761bd507a' +
      'c7b2592d0067c376b2c8980382c11270dc05d9258201b0c769f6888b41671f02',
  },

  batchAuth: {
    payload: {
      version: 2,
      epoch: 1,
      baseCurrency: 'USD',
      sender: 'B55VRAHZV5OLSRTLCPXMVJOV5E',
      ops: [],
      heads: {},
      roster: [],
    },
    signature:
      '32537c30382abfea164042d8d6f3165a21cec7d8b8206475e1db6027bbec5824' +
      '729fe9b13388ddfd49911719a35dfe5031470a8b0a0c4b07185b2079debe0307',
  },

  /**
   * Frames sealed by an earlier build, committed verbatim.
   *
   * Pinning frames that must *open* is stronger than pinning frames that must be *produced*:
   * the nonce is random, so sealing is not reproducible, but opening exercises the header,
   * the associated data, the key derivation, and the padding all at once.
   */
  frames: {
    batch: {
      plaintext: '{"ops":[]}',
      senderDeviceId: 'B55VRAHZV5OLSRTLCPXMVJOV5E',
      recipientDeviceId: 'LT5HMR6GPNRFIAHY5OOTG7LSQ5',
      epoch: 1,
      seq: 9,
      hex:
        '5153590101a7ba61d4acb82cb4cb60df9e11728c1d2c0b033c3becc6b7047f55a4da5508331118f93ddcf988d9811fe2954c43b1f2860bc77f8be915d1eb2b1e2a3d56a6304c57e14c2d8f0ad6bbf26a5deb3c911b0f3de665369352b80a51fc972e615911f51346a6c9cefe1b731499b0c247f5414814dc7b91e3bec0841af1c80bfecb930b42c579e746afbce73bb644d56a5af3716e75d7645862cb20b0adf6dd421b89b6c99617706c111973a9a2c663b0fe68f88c617c1dd10642ffa6d43bfa7bba929b36913f7a840d9bbf1518d1b5e2fa31087580f25d32dcd5cd9cd04dbea274d4b36f625a859f68258e1ea330e77149b18ad06152d14f05ed80c9fd1bd5c9affc376ba7de1a4c10b65cbf0ca68c25467b8d5aaeaeeb71174a35a76e31dfba585471f2d3104c11e660d9cf67d17a7a07da18e39e2b15537790c0bf92bcde47cbef630723e9686e300f433c85e4a32dacb18ae938139d9d0d0e4c368f3a15ef6a492cbf27ed512da60e78011aa42d0242a7ff215e784a5cef2719fb20c01f74fe733d0bc173020f3f52166d67ffa36e26b8c52ffccbd30be840d3fd661da45617f403e877cbacaf52f473c1d5d0f3b0cf2f593557435b73275480c146908c6a3a3ecd988433b600f4d490dd85b2488c943275e562a3874cf66050d8841b7e03ea610162172e7d8420ab8435443aa69b6eea94b8584869e4a7fb8ee707700e3abcda99484796c3380b5bf2b8f6f1e1d256b635b88815b0b78d5f22b1ad80a4434ac4b843d92369293ddac75260664975643c88520769b4d877474d6686beb151277f504b24cacd701d6fcfadfd6c0ed5c725d386fc6966797447af5eadbf61b1e3d665a150b1a201e65b715c4a5557fd6dae2b3e841af765dc7d744bb835000e23fbfc10a4e4aef0c892b192e82722bdc82e7fb3ccac0a648245bf7c55285f097d1a2a5c0abfdb4320d4c67d55ffb54f4f7cc638ee23a5afd2553c02b632ce50eae73092223552d8cab4fa61945989bfcf33e04092e9ca221db6e70f862779ab864b1e92d3586abe1dbbe30a4375a8124380b6d1c44e56106d17e551a2bfded2a1bf23b4327348413fcfb397d23631192359eeeecc6a5ebd5aab62ac597f6054d9dd0d13bc224902686d1f817535becd82218d048dcdf00e93f543f449bd111efbf903a00aaecb15be781122b56aa65e70deb3985cecbcc31c4bffb9a34545e68dd22a778306cf2758cb9671f5a47169d5b3485b80f0428212556d0b8163e191e8f4807ddc737e6ee91bc895d2ccb4fc66a5b105832f1923f75efbcf26abc7e186b6535eca50da210e84907a6e918637829b64ef98f61a9f5537870dd2d39342d4185785ac755993830cbfed6c27eb7d117477ea43419cb887b3ac0eafefdb0999eaf39057bb2f16943269099fccbd7329eb65d5b410b4f46aaa65af65bef485e951b80cd8e19349fb68d7e376449bf9e721402e36cf240ae66efa2510a3f98891402ec4c0ee24ae23ca',
    },
    vaultBundle: {
      plaintext: 'hand carried',
      senderDeviceId: 'B55VRAHZV5OLSRTLCPXMVJOV5E',
      epoch: 1,
      seq: 9,
      hex:
        '5153590105e3a9c2d5f5e91281b69131161665e21d9be0b546259e8265f6277d42d7c50e33da6f0e40beee9c730e9b5de062b664962c54f0352ab4c35d2eb1e7ec6eef5b88647203b3ae8000eb651ec4b9c41ad8fe2096ab8479507acc545c0443a150c811396540e9e03912918fc0e6a076a7e5419e7db9ebca421c048aed8e4497d26f8457b4067a527d872502d1c166f8da3ac0b44d8bdfa7f7f60ccfe665fa595275a04cff0dab45f4bce1660ecf03a51beeb83ee9ccb8cf098b0e694a9bbc97da89854050229f90b427795a564da193901422c5670829a1561234e574cd692779bb25175b7715bbb6e3d28780e4e12fcb218ee795ee012e4c2047920c237600450a9e8b980268edbb23586faf976d3f8e68a362fbb7f625c804a48d38053a27b109955b1c7b391188f53915ba944b94c4c8173cd65ec4b57649414316fd766f0dae694a1b74fc000a0c16d146108b0d7906930329902df24df401fc90e4c7b337fdc576e184db52e6fdc244927c1f7c8ed207b806314094b70ecb86e8066630aa37e4a2a0c2c00f4d9cad020152ad62bf6934a968f32112beeae23d4d4c5da5bcfa2f97ef4153aaf176a0fe7a1aef7b3a0d5f7e8e9e36d9e9367d3bbc59de4ccf33c12b2cf69f23497bf18633cc2fe18ddd9caec5abf6e1a5fe278be213d2398f2bc41676601561b638c6d110e63cca47fdafd2252eb76dd71aa49747464a641c8b74f21e9c2cde5f60e705af65e3e9605270c8823d97b5fcda1676ccc92a2734e626cf785df8127d76c565afdbe2b684eeaf797440438a201d1a358a4971923166aa5037c0925f793cb8e676364caa09be746536d07120e2c60fbccfaf3dcce667a25d544ccc3f52b14e124ff85502b7ff9ee775d3bfb9a259b591a86856dc4bf320b3a28cd039bdf0d5682f8346f0854c6ca3b032dd2f352cb2298aca4dd63372a3f03af087d1df4343bdce7b6a62f082478386dccca32c4b31907a3582581066e64e267b9d76ca502945379c492a4b5b401fada6d61dd0f7a416432a5dab88c43363360c8899bda328f433c7fdb99a7bef0f28b03c7492a3799557ec589b1a4a92404bd2db4c09d5eb49fd7965d7826209ba963e1901933702ad556a728bd0659dd55685886e616da87cf7d6dbc2804b8d444ea8ce20362b6dad21d00188c0a8b5ee328783e33f1efb4b0d399a37a7db18af4bedb74abededc728ab28f2be20d412519175d0898a1086597bd28bb84f9f6c1b8b195cc1e4f04bb6f1557b74a1eff70ec12a0fc982433396a18f562c85ba4d13e0bbc752b1df48deac25eeb6c8d92ccc721bde7e280615c3963654101f59c42d98375767e7e8cf8c62219e2f709ea46d3e7dea39c365d6bac87387bc25592d21834f9d2ec6655e01643db9a811cabc59512fa08c176597cf890847dd93809bd283606d30df81e601b2822251b72efc351fde1eb9c060483bc4bd452450bda88d9497e5d67bf268629721dc992cc043ce400bff76fd3f9',
    },
    passphraseBackup: {
      plaintext: 'backed up',
      passphrase: 'correct horse battery',
      hex:
        '515359420100001000000000080000000100000020bb117e46e9009a21c8220dabc0379e4fe1a2e46a95ce7682ee062a2d65054dfa51535901043f00f907147d3fa149b173af78d79af2b9be14c4695754115fe837b7946b1c278faa98a4be848426c5a7cb0da7cda70ba3d6c0bb29c62dcf0c419c83d90c753dfae1e7041d98ebb71fb79ca48966b86686976b9f8913db891882b37120a4b250d5f5826e9ce0b15b4b3fe0c9662ab0de82ac53cee0d2b58bc75074d0eec7b74e6a88e1c2ff6cddcb093ab1cb8d300e2089d9bcd1b2f48e6f4e267c1cad2e33db082471fbe4dbd60f1d60a7a0accae9be51c326b6a7dd3c3bd1475d7ac199338ebbfffc7c64415f0cbcb61bdd49f2c922e8151731d7c46cd52bec0e4f8345fff925e0799ea085170829ec08a0ee3352ed3588b55880f3f97485a7a0f1605509ae986b68a404200b4600c447a39fd2469903adbaf8ccb739106f6bb3d90949bd62184f1a4af8853d9be71e91c71affca124323c0ab00e2c17522c1b1eacd9787f6e631c41569e0134b3aeca8c678dafdf49af016365fd35b65ebb4b7c5f9478de7fb59508bfe9b951023c188c4df3e22675e76bb4d450ca18cba61924407609b5277e4da699cf4f0c27997b88e45ebf10813d6b74e18f1ed9166bd6c1809193b7681b244268cd0a3b29d45df903d48fda01463493ce2d7bad23f46d59c94bfee3f73905259653fdb223fac028e61f2cfeb09d63f6b454e4687e88629887d9e34bbf6c1011e2fa186ae22a5f783c958b84483e079fff51be0ba7713e3e06b879e7b5d602f673fec413b78a8623e6d6c6fda44e85edf8c114bd4daa7c29908bbef64ed05f495a3143478dac0587ff1c95273f9115cfb25622bc6df63259abb274411b6698b1dceb356744b53c0f7e7705b31241ca54a0197878661346542bb0c5d16b4da31328166bfbca9f00cb732df856438890eb9b2c5be4403354e36a71ec233ed63143ad0a014e2e41eb3d0cf2be5ae1229ec7095b76e0e25cdb9510b9c6025640e357feefd9c1131194c4b642feb5e507491f85fb9b20e02079c123f47b3999c02f54764c1f638b29a82747d5f2e74f0f3207b4df5b1c13bbbeef8b50bcf39c93fc9283cef185d504621608812b55a6d4c025b14e1b4bd4caa429db3429fde6dc4b6e242fcb23264c6e7fe114f886fd7aa68f95badd4648a32d380684ebedc3972462bc2ca65d1581c7abf1604bd65ac35c2536796b5528ba299226b284da371dcb1a429d389c43a1723feba4a256bede162ad9b189b4d93e5e2beaae9008a4e457fc558e9e1b898cb8c996642777169a9877e39041f250cfb0058b6c377d32f1e67dc54f8d5a5bd330eeb2244028db73d3b2eac4cf83fe2c78cec39d77ef2716bde8ee34ddf088d44b1936bd17f0c61bd1a9e47213bad2a7682a29bf7fef0cd2cbb3cc49cd29a533b863631765ba0f6e5424f540164d3cd6b8aa7763e8441583beefc488afc45d3784e5e372ec09f8d83e177bede31b54d2383053ca5df2eee3c3e3b44d70ab6f37f0b10c9d100a77706b2f40700f553c2bda563e0d08783ef1d23beb36dabb4',
    },
  },
} as const;
