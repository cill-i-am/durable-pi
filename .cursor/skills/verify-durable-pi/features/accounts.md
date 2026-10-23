# Sign-in and account security

Protect your own account with passwords, passkeys, two-factor authentication, and browser-session controls.

## Sub-features

- `account-setup`: Complete initial owner setup with the deployment setup key.
- `account-password`: Sign in, sign out, request password recovery, and use a single-use reset link.
- `account-passkeys`: Add, name, rename, remove, and sign in with your own passkeys.
- `account-two-factor`: Enroll an authenticator, complete challenges, and manage recovery codes.
- `account-sessions`: Inspect sessions, revoke one, or sign out other sessions.
- `account-photo`: Upload, replace, and remove your private profile photo.

## How to get to it (user POV)

- Open `/agents` while signed out. Use **Sign in**, passkey sign-in, or **First time? Set up your account** where offered.
- Open `/forgot-password`, `/reset-password` from its email link, or `/two-factor` during sign-in.
- Open Settings from the account menu. `/settings/account` owns the profile photo; `/settings/security` owns passkeys, two-factor authentication and browser sessions.
- Open `/settings/preferences` for appearance, activity animations, interaction sounds and default message delivery. These preferences are saved in this browser/device, not separately for each agent or synchronized across devices.
- Invited members enter through their invitation link; see [Family](family.md).

## Driving it with the verification harness

Preconditions: Use disposable identities and a virtual authenticator for automated tests. Real passkey enrollment needs the account holder's device confirmation.

- **Password journey.** Run `pnpm test:browser tests/browser/workspace.spec.ts --project=desktop --grep 'sign in, open an agent'`. An incorrect password fails, the fixture password signs in, and authenticated chat opens.
- **Passkey journey.** After `pnpm build`, run `node --import tsx scripts/check-passkeys.mjs`. The built-site harness enrolls, signs in, renames, removes, and rejects invalid assertions with a disposable database.
- **Photo journey.** Run `pnpm test:browser tests/browser/profile-photo.spec.ts --project=desktop`. Replacement survives reload; removal clears the photo.
- **Recovery and sessions.** On the real app, request recovery only for the test account. Verify the inbox link, then inspect Account security from a second browser session before revoking it.
- **Proof.** Record the requested action and a fresh sign-in or session check. Do not capture passwords, setup keys, QR secrets, recovery codes, or private reset links.

## Gotchas

- The virtual-authenticator test does not prove iPhone or Android device behavior.
- Removing a passkey does not sign out existing sessions. Session revocation is a separate action.
- Signing out does not stop durable agent work or revoke the shared ChatGPT connection.
- Password reset preserves an enabled second factor. Passkeys remain bound to the app's relying-party hostname.
- Personal settings have no selected-agent prerequisite. Existing sign-in and family-admission checks still apply; moving settings does not grant family access or change account permissions.
