# Lifecycle refactor release — 25 October 2026

**Merged, deployed and verified.** All 28 pull requests in stack #202 were merged into `b7b465cecc86e782d8a3c578914cdac80553960f`. Its Git tree, `c78036149ae64a8268ccaba0363c3be7b9b6f313`, matches the tested stack head `a9bc8993102b9e7fda63ed82e789427a9ee4143e`. The 40 implementation commits remain unsigned and retain their ancestry.

## Release verification

The [production workflow](https://github.com/cill-i-am/durable-pi/actions/runs/40175969812) passed all eight jobs, including aggregate `check` and deployment:

- Static checks, 3,918 tests in 334 files, website routing and all seven Worker builds.
- Fifteen native runtime suites covering SQLite/Pi/Lifecycle recovery, process termination, real lease expiry and joined cancellation.
- 322 browser journeys, eight deliberate viewport skips, 29 mounted-component cases, passkeys and two-build upgrade recovery.
- Both container gates.

At 08:43:17 UTC the readiness check confirmed the full merged revision on the website, Worker and the one active agent. At 08:43:20 UTC the hosted authentication check passed. Desktop and mobile sign-in smoke checks reported no page errors or console messages.

## Signed-in production smoke

The signed-in production conversation used the configured `gpt-6.1-sol` model and one explicitly approved terminal invocation. The command printed a fixed marker without reading or modifying files, accessing the network, changing settings or contacting anyone. The owner selected **Allow once**.

The saved receipt `command:1883` reported `succeeded`, exit code `0`, and output `PI_PRODUCTION_SMOKE_20261025:323`. The model returned exactly that marker. A full page reload retained the same receipt, completed tool result and reply. Browser warning/error logs were empty.

This verifies one real model → approval → terminal → reply → reload journey. Synthetic native tests remain evidence for their tested failure scenarios; this smoke does not establish live delivery for every external provider or exactly-once external execution.

## Audit interpretation

The [inventory](xstate-effect-inventory.md) records the completed ownership migration. The [settings integration](xstate-effect-settings-integration.md) records the final source census. Earlier audit documents and raw logs retain their original commit and test scope. Their draft, unmerged, skipped-deployment and pending-check statements describe pre-merge checkpoints, superseded by this release record.

Merged PRs: [#200](https://github.com/cill-i-am/durable-pi/pull/200), #201, #204–#217, #219–#221 and #223–[#231](https://github.com/cill-i-am/durable-pi/pull/231). Historical failures and negative controls remain preserved; passing release gates do not rewrite those observations.

The subsequent ten-pass adapter and guard simplification is tracked separately in [the simplification plan](lifecycle-flow-simplification.md). This release evidence applies to the revision above, not to later edits.
