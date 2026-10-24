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

The fixtures now use the canonical Preferences page, the alert's text content and a backend-valid tool ID. `browser-model-sound-recheck` passes all eight desktop/mobile cases; `browser-assignment-recheck` passes both viewport journeys while retaining exact agent/operation assertions. `browser-final` records a successful isolated `pnpm verify:browser`: 322 journeys pass, eight viewport-specific cases intentionally skip, all 29 mounted-component cases pass, actual passkeys pass and the two-build upgrade passes. No concurrent process rebuilds its assets. `unit` is the final full rerun on the published drawer source, again passing all 3,918 cases.

All provider/model responses are synthetic. Local browser viewports do not establish physical-phone behavior. Historical CI `40133743444` passed on the recorded old #230 head; `previous-pr230-ci.json` verifies that boundary. The newly rebased PR checks remain separate. No merge, deployment or live external delivery is claimed.

## Hosted browser job allowance

`ci-browser-timeout.log` and `ci-browser-timeout-job.json` retain #221 job `120999590261`: it ran from 22:02:14 to 22:22:30 UTC, passing all 322 browser journeys in 18.5 minutes plus all 29 mounted-component checks. The 20-minute job limit cancelled it during passkey verification. The expected foreign-origin rejection in the last log lines belongs to the negative authentication test; it is not the cancellation cause.

The browser job now has 30 minutes to include installation, builds, every journey, passkeys and two-build upgrade. Native-runtime remains at 20 minutes and the other verification suites at ten. No test deadline, assertion, required job or deployment condition changes. `workflow-check.json` records passing local actionlint 1.7.12. The correction is a separate unsigned commit in #221 and is rebased through its dependent PRs; the current crosswalk records both sets of heads. Application and test contents are byte-for-byte unchanged by that rebase. Refreshed hosted checks remain required.

## Native fault-fixture retention

The first native job for #229 (`121006419511`, head `ea691c7`) passed the Workspace recovery checks, then correctly rejected its reply-outage fixture because the simulated SQL failure was no longer active. `native-fixture-ci-failure.log` preserves that result. The fault switches live in the native object's memory; the old keep-alive loop started only after both channels were prepared, leaving an idle interval during setup.

An isolated transform inserted a twenty-second wait immediately after `prepareOutages` for email. On source `46523c1`, this reproduces `email/all-sql: SQL fault fixture was evicted` (`native-fixture-idle-before.log`). The unmodified native script passes (`native-fixture-original-pass.log`), establishing the timing-sensitive boundary rather than a deterministic application failure.

The existing keep-alive scope now begins before channel setup and registers each outage immediately after creation. The same twenty-second transform passes all native reply-outage, discovery, attachment, multipart receipt and Chat SDK state assertions (`native-fixture-idle-after.log`). Keep-alive performs no domain or queue work; no assertion, test deadline, production lease or application source changes. The artificial delay is confined to the verification transform and is not added to normal CI. `native-fixture-repair.json` records both fixture hashes, source boundaries and artifact hashes. Final #231 CI includes this test-harness correction; the unchanged #229 retry retains its own scope.
