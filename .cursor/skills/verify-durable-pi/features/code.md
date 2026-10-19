# Isolated JavaScript execution

Run a bounded JavaScript calculation with explicit JSON input and inspect its saved logs and result.

## Sub-features

- `code-run`: Execute JavaScript through `run_code` or the Code workbench.
- `code-input`: Supply explicit JSON data and receive bounded output/logs.
- `code-history`: Reopen prior runs and saved results.
- `code-stop`: Cancel execution and preserve interrupted/uncertain status without automatic rerun.
- `code-isolation`: Keep execution separate from files, network, app bindings, and model credentials.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/code` or choose Code in **Workbench tool**.
- Fill **JavaScript** and **Input JSON**, then run through the visible action.
- Ask the agent for a local calculation using `run_code`. Inspect **Code run history** and **Run output**.

## Driving it with the verification harness

Preconditions: Use pure code such as `return input.a + input.b` with JSON `{"a":2,"b":3}`. Real execution requires the private deployed service.

- **Run.** Submit the calculation from Code or chat under existing tool policy; inspect result `5` and the saved run.
- **Reopen.** Reload Code, select the completed history entry, and confirm its unchanged input/result without another run.
- **Stop.** If testing cancellation, use a bounded harmless test and verify its saved interrupted/cancelled state before retrying.
- **Checks.** Run `pnpm test tests/execution.test.ts tests/execution-native.test.ts tests/execution-boundary.test.ts`.
- **Proof.** Record input, action, saved run identity, output, and a second read. A fresh run with the same output does not prove replay.

## Gotchas

- This is not the Linux terminal. It has no network, filesystem, application bindings, or model credentials.
- Only one run is active at a time, with one-second CPU and ten-second elapsed budgets.
- Interrupted execution is not automatically repeated. An Ask policy still requires its exact approval.
