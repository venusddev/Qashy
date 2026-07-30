/**
 * WebRTC on iOS and Android, if this build has it.
 *
 * `react-native-webrtc` is a native module: it cannot be loaded by Expo Go, and it only
 * exists in a development or EAS build that was compiled with it. So it is resolved lazily
 * and optionally rather than imported at the top of the file, and the distinction matters in
 * three ways:
 *
 * - **A missing module is a supported state, not a crash.** `available` goes false, the
 *   session falls back to the relay, and the sync screen says *"direct connections need a
 *   development build"* instead of the app dying on a `ReferenceError` the first time
 *   somebody opens the pairing wizard in Expo Go.
 * - **Nothing else has to change when it appears.** Install it, rebuild, and direct sync
 *   lights up — the engine, the handshake, and the UI are all already written for it.
 * - **The relay path stays honest.** It is not a degraded mode bolted on for the missing
 *   case; it is the same transport a phone uses whenever the laptop is shut, and it is
 *   already the more-used of the two.
 *
 * As of this writing `@config-plugins/react-native-webrtc` declares a peer dependency on
 * Expo SDK 56 and cannot be installed against SDK 57 without overriding npm's resolution,
 * which `AGENTS.md` forbids for exactly the reason it exists. When that plugin catches up,
 * installing it and adding it to `app.json` is the whole of the work.
 */

import type { IceServer } from '@/sync/transport/endpoints';
import { UNAVAILABLE_RTC, type RtcConnection, type RtcFactory } from '@/sync/transport/webrtc-core';

type PeerConnectionCtor = new (config: { iceServers: IceServer[] }) => RtcConnection;

/**
 * Resolves the native module, once, without letting its absence propagate.
 *
 * `require` rather than `import` is deliberate: a static import is resolved by Metro at
 * bundle time and would fail the build outright on a project that has not installed it,
 * which is precisely the project this branch exists to support.
 */
const load = (): PeerConnectionCtor | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require('react-native-webrtc') as { RTCPeerConnection?: PeerConnectionCtor };
    return typeof module.RTCPeerConnection === 'function' ? module.RTCPeerConnection : null;
  } catch {
    return null;
  }
};

const PeerConnection = load();

export const rtcFactory: RtcFactory = PeerConnection
  ? {
      available: true,
      create: (iceServers: readonly IceServer[]) =>
        new PeerConnection({ iceServers: iceServers.map((server) => ({ ...server })) }),
    }
  : UNAVAILABLE_RTC;
