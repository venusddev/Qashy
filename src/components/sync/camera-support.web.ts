/**
 * Whether this browser can open a camera at all.
 *
 * Two failures look identical to a user and neither is a permission prompt they can accept,
 * so both have to be detected before one is offered:
 *
 * - **No camera.** A desktop without a webcam, which is most of them.
 * - **An insecure context.** `getUserMedia` is only exposed over HTTPS or on `localhost`, and
 *   a self-hosted PWA reached at `http://192.168.1.4:8081` is precisely the setup someone
 *   syncing between their own devices is likely to have. `navigator.mediaDevices` is simply
 *   `undefined` there — no error, no prompt, nothing to catch.
 *
 * The scanner's answer to both is the manual pairing code, which is a real path rather than a
 * consolation prize: it is the same secret, typed instead of photographed.
 */
export const cameraSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
