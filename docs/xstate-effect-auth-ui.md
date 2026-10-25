# Auth frontend lifecycles

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

F08 moves request admission and completion into feature-owned machines using the official `@xstate/effect` integration. Better Auth, its passkey plugin, and the server remain the authentication and session authority. No authentication endpoint, session rotation rule, trust-device setting, or server security check changes.

`auth-entry.machine.ts` admits one immutable request for login, initial setup, password recovery, reset, or a sign-in challenge. Requests retain redacted input and clear it after settlement. A failed challenge permits an explicit retry or a different challenge method; a rejected reset token ends that link's flow. Each reset hash change owns a fresh component and Effect scope, including token A → B → A. Successful completion callbacks run inside the request's owned invocation.

`factor.machine.ts` separates password confirmation, authenticator verification, and recovery-code review. Verification keeps the exact enrollment material. Codes remain redacted in context, are revealed only for rendering/copy/download, and require the existing explicit saved-codes acknowledgement. The parent account-security actor receives the child's busy/review projection and refuses dismissal or competing session commands. Downloaded recovery-code object URLs belong to an Effect acquisition and are revoked on normal completion or scope closure.

`passkeys.machine.ts` owns the list, editor selection, native enrollment, rename/removal, and recovery after an uncertain result. A command retains its admitted key and name. Failed reads and unknown verification outcomes require an explicit successful refresh before another mutation. `security.machine.ts` owns session reads, current-session exclusion, confirmation, revocation, and child locks. Confirmation resolves the current authoritative list entry; session tokens are redacted. A session identity change closes the previous scope, so an old revoke response cannot refresh or annotate the new account view.

`photo.machine.ts` separates preparation, upload/removal, and session refresh. Native image preparation is joined before its observer scope can close. Leaving during preparation cannot admit the later upload. The existing decoder still closes its `ImageBitmap` in `finally`; the machine releases references to the original file and prepared blob after their stages settle.

`auth-owner.ts` is the auth-local React/Effect scope bridge. It contains no request admission or workflow state. It joins the official actor host on teardown, fences late React callbacks, and retains late native defects with their accompanying Cause reasons. Ordinary observer interruption is not server rollback. The installed passkey SDK does not forward caller signals to its initial options request or native ceremony; its final verification request accepts the signal. The owner joins the SDK promise and fences stale completion without claiming to cancel a device prompt. The existing `PasskeySignIn` props remain unchanged.

Password visibility, typed password/code/name values, QR-key visibility, and DOM focus remain plain UI values. SDK session polling and device internals remain SDK-owned.

## Evidence and limits

`tests/auth-ui-lifecycle.test.ts` exercises duplicate admission, explicit challenge retry, invalid reset tokens, native abort-and-join with compound Cause retention, photo stage boundaries, code review acknowledgement, object URL cleanup, uncertain passkey outcomes, immutable key selection, and exact session revocation with child locks.

Isolated mounted probes in `/private/tmp/f08-auth-ui` establish two original counterexamples: an unmounted challenge navigated after a held success, and an unmounted photo view uploaded after held image decoding. The unchanged probe passes after migration; removing scope cleanup in a temporary bundle restores both failures. A separate mounted probe exercises reset-token and session ABA changes, wrong-code retry, non-dismissible recovery review, and download cleanup.

The native capability probe uses the installed Better Auth passkey client and Chromium's virtual CTAP2 authenticator. Actual credential creation and assertion both retain active user activation and produce matching credential verification payloads. All endpoints are intercepted synthetic local fixtures. This proves frontend/SDK/browser integration, not backend cryptographic verification or a real account change. No real sign-in, account mutation, external provider, deployment, or broad browser gate was performed for this slice.
