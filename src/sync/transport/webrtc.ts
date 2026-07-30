/**
 * The fallback Metro and TypeScript resolve when neither platform suffix applies.
 *
 * Under Jest there is no `RTCPeerConnection` and no native module, and a suite that
 * accidentally opened a real peer connection would be a suite that hangs. Reporting
 * "unavailable" is both true here and the same answer the transport already knows how to
 * handle everywhere else.
 */

import { UNAVAILABLE_RTC, type RtcFactory } from '@/sync/transport/webrtc-core';

export const rtcFactory: RtcFactory = UNAVAILABLE_RTC;
