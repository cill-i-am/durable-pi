# Passkeys

Each family member can add, rename and remove their own passkeys in Account security (`/agents/home/settings/security`). Sign-in and invitation sign-in offer a passkey alongside the existing password flow. Account recovery still uses the existing password reset and email flow. This slice does not create shared credentials or change the family's model connection.

The [Paper screens](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-5-0) extend the existing Pi security dialog, including mobile, dark mode, setup, removal and recovery states. Setup launches the browser's native device confirmation. Pi never receives a fingerprint, face image or device PIN.

## Authentication boundary

The pinned `@better-auth/passkey` plugin owns challenges, signed cookies, credential storage, verification, counters and sessions. Its relying party ID is the hostname of `APP_URL`; the allowed origin is that URL's exact origin. Keep the production hostname stable: keys enrolled for another relying party do not transfer automatically.

Enrollment requires a live family membership and the native plugin's fresh browser session. Key management uses live membership and the plugin's ownership checks. An admin cannot inspect or change another person's keys. Passkey sign-in proves identity; the existing family admission checks still control workspace access.

Both ceremonies require device verification through `authenticatorSelection.userVerification`. The pinned 1.7.25 plugin uses this setting in its browser options and server verification for registration and authentication. The older application callbacks and authentication-options rewrite are removed. Password sign-in retains its existing two-factor challenge; passkey sign-in requires verified device unlock.

The Vite server build bundles `@better-auth/passkey` with Better Auth so its errors share the same `APIError` constructor. The built-site browser suite checks native verification rejection codes and confirms that rejected assertions create no session and rejected registration creates no credential.

## Chat and recovery

`read_passkeys` returns only the caller's row IDs, names, creation dates and authenticated setup URL. `manage_passkeys` follows the existing mutation approval policy for setup instructions, rename and removal. The host derives identity from the private actor and uses the same native Better Auth management APIs as the screen. Tools receive no public keys, credential IDs, challenges, biometric data or session tokens.

Chat setup returns `device_confirmation_required`; it never enrolls a key. The person opens Account security and confirms on their device. Removing a key leaves existing browser sessions signed in. Use the existing browser-session controls separately when revoking an already signed-in device. An uncertain mutation asks for a fresh list before retrying.

## Verification and rollout

Apply the additive auth migration `20261017205155_passkeys` through the normal deployment migration step before serving this version. No new secret or infrastructure binding is required.

`tests/passkeys.test.ts` exercises the native plugin over the production D1 queries with isolated SQLite: membership and freshness, private management, agent identity, safe tool output and one-use challenges. Existing account-security tests cover password and two-factor behavior.

`scripts/check-passkeys.mjs` runs against the production website build with a disposable database and Chromium virtual authenticator. It creates a discoverable key, signs in without a password, renames and removes it, verifies focus and recovery, and rejects wrong-origin assertions, replay, missing device verification and stale enrollment. It also checks mobile overflow, dark action colors and 200% zoom. It does not enroll a production key or prove real iPhone/Android device behavior. Real-device acceptance requires the account holder after deployment.
