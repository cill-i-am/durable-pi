# Routine runner and native failure boundary evidence

The manifest records final source hashes above unsigned Conversation commit `7ce831d` and raw log hashes. Logs preserve their original whitespace.

## Controls and corrections

- `before`: two added tests reproduce duplicate exhaustion by the original adapter, using either one facade or two warm facades sharing the native owner. The other seven cases pass.
- `after-first`: all nine original and reproduced callback cases pass with shared machine admission.
- `focused`: four held storage/exhaustion cases expose checked/defect/interruption reasons lost by native Effect.runPromise. Promise rejection carrying a Cause had not tested this checked Effect path.
- `cause-control`: reverting just the complete-Exit adapter bridges fails eight strengthened Routine/Conversation cases; 62 others pass. `cause-after` passes all 70.
- `native-binding-control`: the actual PersonalAgent Conversation and Routine callback bindings lose complete failures when reverted to runPromise. Both original bindings return complete=false; the corrected runPromiseExit bridge preserves original failure, defect and interruption. The final probe uses a declared RoutineStorageError shared by both domain error types.
- `native-join-before`: the actual host closes resources before accepted Routine callback work settles. The final host joins Routine concurrently with provider shutdown and the same ordering check passes.

## Final results

- `focused-final`: all 70 Routine and Conversation cases pass, including shared admission/closure, exact SDK identity, stored revisions, queued writes, new facades after closure, complete failure reasons and runtime validation.
- `static-complete`: types, lint, formatting, migrations and static gates pass; staged publication secret scanning is retained separately.
- `unit-complete`: all 3,754 tests in 330 files pass.
- `build-complete`, `routes-complete`, `workers-complete`: website/route verification and all seven Worker bundles pass.
- `native-personal-complete`: full PersonalAgent/Communication runtime suite passes, including complete callback Causes and four held runner joins before runtime/SQL closure.
- `native-routines` and `native-conversation`: actual retained alarms, SIGKILL/restart, exact receipts, bounded recovery and original-session ownership pass. Provider responses are synthetic.

No payload/schema migration, new execution journal, alarm owner or retry budget is introduced. Communication and Workspace runner migration and the other retained runner Promise-boundary audit remain open. Hosted CI on the new commit is a separate publication gate. No merge, deployment or live-provider delivery is claimed.
