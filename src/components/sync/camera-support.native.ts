/**
 * Every phone and tablet Qashy runs on has a camera.
 *
 * Whether it may be *used* is a permission question, which `useCameraPermissions` answers
 * with a prompt the user can act on — a different thing from the browser's case, where the
 * capability can be absent with nothing to grant.
 */
export const cameraSupported = () => true;
