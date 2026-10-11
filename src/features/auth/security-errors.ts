export function securityError(
  error: { code?: string; message?: string } | null | undefined
) {
  if (!error) return ""
  switch (error.code) {
    case "INVALID_TWO_FACTOR_COOKIE":
    case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      return "This sign-in has expired or has too many attempts. Sign in again to continue."
    case "INVALID_CODE":
      return "That code didn’t work. Try the current code in your authenticator."
    case "INVALID_BACKUP_CODE":
      return "That recovery code didn’t work. Check it hasn’t already been used."
    case "SESSION_NOT_FRESH":
      return "Sign in again before managing your security settings."
    case "UNAUTHORIZED":
      return "Your session has ended. Sign in again to continue."
    case "ACCOUNT_TEMPORARILY_LOCKED":
      return "Too many attempts. Wait 15 minutes before trying again."
    default:
      return error.message ?? "Could not complete that request. Try again."
  }
}
