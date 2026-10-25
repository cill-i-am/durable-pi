export function supportsPasskeys() {
  return (
    window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    !!navigator.credentials
  )
}

export function passkeyErrorCode(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined
}

export function passkeyError(error: unknown) {
  switch (passkeyErrorCode(error)) {
    case "SESSION_NOT_FRESH":
      return "Sign out and sign in again before adding a passkey."
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again to continue."
    case "PASSKEY_DEVICE_VERIFICATION_REQUIRED":
      return "Unlock your device with your fingerprint, face or PIN, then try again."
    case "AUTH_CANCELLED":
    case "REGISTRATION_CANCELLED":
    case "ERROR_CEREMONY_ABORTED":
      return "Device confirmation did not finish. Try again when you’re ready, or use your password."
    case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED":
      return "This passkey is already added. Use it to sign in, or add a different passkey."
    default:
      return "Could not confirm the passkey request. Try again or use your password."
  }
}
