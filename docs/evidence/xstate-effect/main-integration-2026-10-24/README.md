# Main integration verification

The stack is rebased onto main `1f800d419d1823de1bda960721d89964ae06a492`. `rebase-crosswalk.json` preserves the prior published heads, rebased heads and trees, including the browser fixture repairs applied to their owning PR layers. Every rewritten commit is unsigned. Other local checkouts were not changed.

`manifest.json` records 1,018 source/input hashes for the integrated code and exact hashes of the retained artifacts. `source-files.txt` enumerates 1,012 source paths, including 192 machine modules. `control-candidates.txt` is a discovery index; the responsibility review and exclusions are in [the integration review](../../../xstate-effect-settings-integration.md) and [inventory](../../../xstate-effect-inventory.md). Generated route-tree output is excluded from the source hashes because the route generator and Vite add different generated registration details.

## Passing checks

- `unit`: 3,918 tests in 334 files.
- `static`: route generation, migration consistency, TypeScript, zero-warning lint, formatting and the then-tracked secret scan. Publication also scans newly staged files.
- `workers`: all seven production Worker builds. The website production build is included in the browser gate.
- `native`: all fifteen required suites pass, including actual PersonalAgent bindings and nine joined runners; native SQLite/Pi/Lifecycle recovery, retained discovery without requests, finite budgets, exact identities and repeated SIGKILL/restart.
- `container`: both required images build; unchanged image layers use Docker's cache.
- `drawer-focused`: 39 drawer/model cases. `drawer-negative` removes revision validation through the isolated transform in `drawer-negative-transform.txt`: the stale-close test fails while six other drawer cases pass. Production source is never changed by this control.
- `connections-focused`, `settings-focused`, `heartbeat-focused`: integration boundary regressions, including library versus assignment authority, persisted channel targets, guarded sign-in, retained workbench and upstream heartbeat expiry.
- `components`: 29 mounted Skills, Memory and workspace cases.
- `passkeys`: actual built frontend and native Better Auth/SQLite WebAuthn proof, including throttled repeated cancel/focus cycles.
- `upgrade`: two real frontend builds preserve drafts and attachments and submit nothing during retired-asset recovery.

## Browser diagnostics and corrections

`browser-baseline` passes 20 applicable current-main journeys with six intentional desktop skips. `browser-composed-before` passes 48, skips six and fails four viewport instances: obsolete family model-access URLs and the missing catalog-reload control. Both causes are corrected.

`browser-interrupted` retains the initial whole-suite run: 273 pass, eight intentionally skip and 49 fail. Three desktop failures identify an obsolete Preferences URL, an exact-text selector containing the new Reload button, and a synthetic remote-tool name that violates the existing command schema. The final 46 failures follow an orchestration error: a concurrent focused fixture build replaced the shared `dist/browser` directory; the full-run fixture server exits on a missing `.build-revision`. Those server-loss failures do not establish application defects.

The fixtures now use the canonical Preferences page, the alert's text content and a backend-valid tool ID. `browser-model-sound-recheck` passes all eight desktop/mobile cases; `browser-assignment-recheck` passes both viewport journeys while retaining exact agent/operation assertions. A complete isolated browser rerun remains pending; no concurrent process rebuilds its assets.

All provider/model responses are synthetic. Local browser viewports do not establish physical-phone behavior. Historical CI `40133743444` passed on the recorded old #230 head; `previous-pr230-ci.json` verifies that boundary. The newly rebased PR checks remain separate. No merge, deployment or live external delivery is claimed.
