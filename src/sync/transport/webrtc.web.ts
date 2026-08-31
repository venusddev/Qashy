/**
 * WebRTC in a browser, which is the one place it needs no dependency at all.
 *
 * `RTCPeerConnection` has been in every shipping browser for years, so the PWA gets direct
 * device-to-device sync out of the box — no native module, no dev build, nothing to install.
 * The `available` flag still exists because a browser old enough to lack it, or a hardened
 * environment that has removed it, should produce "this device will use the relay" rather
 * than a `ReferenceError` from inside a pairing flow.
 */

import type { IceServer } from '@/sync/transport/endpoints';
import { UNAVAILABLE_RTC, type RtcConnection, type RtcFactory } from '@/sync/transport/webrtc-core';

type PeerConnectionCtor = new (config: { iceServers: IceServer[] }) => RtcConnection;

const constructor = (): PeerConnectionCtor | null => {
  const found = (globalThis as { RTCPeerConnection?: PeerConnectionCtor }).RTCPeerConnection;
  return typeof found === 'function' ? found : null;
};

export const rtcFactory: RtcFactory = constructor()
  ? {
      available: true,
      create: (iceServers: readonly IceServer[]) => {
        const Ctor = constructor();
        if (!Ctor) return UNAVAILABLE_RTC.create(iceServers);
        // Copied into a plain array because the platform mutates nothing but does read the
        // list eagerly, and a frozen readonly array from settings has no business being
        // handed straight to a browser internal.
        return new Ctor({ iceServers: iceServers.map((server) => ({ ...server })) });
      },
    }
  : UNAVAILABLE_RTC;
