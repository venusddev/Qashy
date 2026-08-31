/**
 * The fallback Metro and TypeScript resolve when neither platform suffix applies.
 *
 * Under Jest there is no camera and no `navigator.mediaDevices`, so "unsupported" is both
 * true and the branch worth exercising: it is the one that renders the manual code path,
 * which is the only one a test without a camera could drive anyway.
 */
export const cameraSupported = () => false;
