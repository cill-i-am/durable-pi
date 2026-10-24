# Conversation runner lifetime evidence

Raw logs retain their original whitespace; the manifest records artifact and final source hashes above unsigned Memory commit `068158f`.

## Failure-sensitive controls

- `conversation-runner-before`: the preceding adapter admits the exact same SDK callback twice and prematurely exhausts a receipt while its callback remains held. Both added regressions fail; the other 34 tests pass.
- `conversation-runner-native-join-control`: the real PersonalAgent closes actor resources before accepted Conversation work joins. The same test passes after adding Conversation disposal alongside provider/credential/other runner shutdown.

## Diagnostic corrections

- `after-first`: the older newer-job test deletes the native job before asynchronous admission enters the callback. It now waits on an explicit entered barrier before replacement, preserving its original retention assertion.
- `focused`: original Cause reasons survive, but the official Effect invocation adds a stack annotation. Assertions now check original error/defect identities, interruption identity and original annotations while allowing this additional diagnostic annotation.
- `focused-complete` and `unit-complete`: two added exhaustion tests injected a Cause through Promise rejection inside `Effect.exit`, which represents a defect. The fixture now emits the intended checked failure with `Effect.failCause`. The unit checkpoint passes all other 3,739 tests.
- `native-join-before`: the new probe initially lacked its routing entry. That fixture setup failure is not evidence of a production defect. The registered probe then reaches the actual failing shutdown-order control above.

## Final results

- `focused-final-50`: all 50 Conversation runner cases pass.
- `static-final`: types, architecture lint, formatting and migration/static checks pass. Publication secret scanning separately includes staged new files.
- `native-conversation`: real held submit/abort cleanup, full sixty-second no-request discovery, SIGKILL receipt reconciliation without a repeated synthetic provider call, bounded exhaustion, explicit recovery and original-session reuse pass.
- `native-personal`: the complete PersonalAgent/Communication suite passes, including the real callback join before runtime and SQLite disposal.
- `unit-final`: all 3,741 tests in 330 files pass.
- `build-final`, `routes-final`, `workers-final`: website/route checks and all seven Worker bundles pass.

Provider responses are synthetic; native Pi, SQLite, alarm delivery, process termination and runtime ownership are real. Existing ledgers, payloads, revisions, receipt identity and three-attempt budgets are unchanged. Communication, Workspace and Routine runner migrations remain open. Hosted CI on the new commit remains a publication gate. No merge/deployment or live-provider delivery is claimed.
