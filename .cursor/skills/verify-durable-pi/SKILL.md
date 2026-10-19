---
name: verify-durable-pi
description: Verify Durable Pi web, email, and WhatsApp user journeys using the existing Playwright fixture, native runtime suites, and authorized real-app acceptance. Read the feature map before changing or testing a capability.
---

# Verify Durable Pi

Use this skill to find a feature's real entry points, drive a bounded user journey, and report what was actually proved. Read the [feature map](features/README.md) first. Use the [source register](references/source-register.md) when checking drift.

The primary surface is the web app. Email and WhatsApp are adapters over the same conversations, files, and permissions. WhatsApp's live provider setup is parked. Do not configure it as part of verification unless the user resumes that work.

This skill follows Cursor pstack's [create-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md), retrieved October 19, 2026. The prose follows the requested NBJ Write Clearly guidance. This project-local directory contains the generated map, not a modified copy of the upstream skill.

## Launch

Run from the repository root with Node 24+ and the pinned pnpm version. Install dependencies with `pnpm install --frozen-lockfile` if absent. First require `pnpm build` to pass.

For the repeatable disposable web journey, use the repository's existing harness:

```sh
pnpm test:browser tests/browser/workspace.spec.ts --project=desktop --grep 'sign in, open an agent' --trace on --output /private/tmp/pi-feature-map-evidence-19oct
```

`playwright.config.ts` starts `scripts/performance/server.mjs` at `http://127.0.0.1:4399` with `PERF_CASE=journey` and `PERF_DIST=dist/browser`. The server builds the real frontend, starts with new in-memory fixture state, and prints `Synthetic performance fixture ready`. Playwright owns the process and stops it after the test, including failure. It does not reuse an existing server.

The browser fixture creates disposable synthetic auth/model/storage state. Sign in as `browser-smoke@example.invalid` with `Disposable browser fixture password 2026!`. These are fixture constants, not production credentials. Opening the **Navi** collection link reaches the usable composer at `/agents/navi`.

For real local runtime work, use the documented [Run it](../../../README.md#run-it) flow: private `.env`, authenticated Alchemy profile, `pnpm dev`, initial owner setup if empty, and separate model sign-in. Keep that stack's actual printed origin. Do not create two Alchemy instances against the same stage/state or copy production credentials into a test fixture. Native actor harnesses use their own temporary state; prefer `pnpm verify:native-runtime` for restart checks.

For hosted acceptance, open the existing production app in an authorized signed-in browser. Observe its current identity and prerequisites before sending or mutating anything. The fixture command does not launch or modify production.

## Doctor

For the disposable browser journey, the first read-only drive opens `/agents` and requires the **Welcome back.** heading. The successful sign-in must then reveal **Your agents**, a **Navi** link, and an enabled **Message Navi** composer. Treat missing app identity or readiness as a failed doctor, not a reason to drive guessed selectors. The initial check and subsequent sign-in are recorded in the trace.

If launch fails because port `4399` is occupied, identify its owner and stop this run. Never kill by process name. If a drive behaves unexpectedly, reopen its known starting page and recheck identity; after an unrecoverable fixture failure, let Playwright clean up and start a fresh run.

For the real app, check the canonical origin, signed-in person's identity, selected agent, and model/channel availability before a journey. Build status is not session or provider readiness. Operators with the existing setup token can run the repository's `scripts/check-deployment.ts` through its documented CI environment to compare website, Worker, and active-agent revisions. Do not expose that token or make a new public health endpoint.

## Drive

The default path is the exact Playwright command in Launch. It signs in, opens the agent through its visible link, attaches a small PNG through **Choose files**, fills **Message Navi**, selects **Send message**, waits for **Fixture reply received.**, and reloads the saved answer/image/download. It blocks unexpected requests outside the fixture origin.

Use another feature file's command for an existing scripted journey. To cover both layouts, omit `--project=desktop` or run its mobile project separately. Do not run several Playwright invocations concurrently against port `4399`.

Real-app journeys in the feature files name the action and observable result for a browser-driving harness. They do not imply an existing end-to-end script. Read the actual current accessibility state before interacting; keep exact controls and routes from the map, and record a harness gap when automation is missing. No production DB setter or fixture API is a substitute for a user action.

For a real frontend build transition with disposable backend state, run `pnpm test:client-upgrade`. It builds two revisions, retires the first build's assets while its tab stays open, drives the explicit recovery action, and checks draft/file preservation without a send. Use `PI_BROWSER_CHANNEL=chrome` for installed Chrome. Evidence defaults to ignored `test-results/client-upgrade`; cleanup removes only its owned browser/server/build directories and retains the evidence.

## Evidence

Keep the Playwright trace in the output directory named in Launch. The trace captures actions, DOM snapshots, and screenshots of the interaction. The existing config also captures a separate screenshot on failure; this installed CLI has no `--screenshot` flag. A passing exit code must accompany the artifacts. Native checks retain their process/output evidence separately. For real-provider acceptance, verify the actual inbox or provider outcome and the corresponding Pi request/file/decision record.

The [proof record](references/proof.md) states exactly what was exercised when this skill was created. Its fixture run proves the real frontend with synthetic boundaries. It does not prove production auth, persistence across process restart, model inference, Cloudflare media services, email delivery, or WhatsApp acceptance. Those remain separate feature-specific checks.

Keep private addresses, tokens, reset links, raw auth secrets, and private source content out of committed evidence. If a safe dry-run is used elsewhere, observe its actual file/network effects rather than trusting its name.

## Cleanup

Let Playwright terminate only the web server it started and close its browser context. Verify that its command exited, fixture port `4399` is no longer listening, and evidence files still exist. After a failed iteration, perform those same checks before retrying. Do not delete traces during cleanup.

For an independently launched local stack, stop only the recorded process/session for that run. Preserve its private state unless it was explicitly disposable. Clean real-app test records through their normal archive/restore controls; never delete unrelated user work, revoke a real account, or stop another person's task to tidy a verification run.

## Maintain the map

Use [pstack maintain-verification-skill](https://github.com/cursor/plugins/blob/main/pstack/skills/maintain-verification-skill/SKILL.md) when auditing this directory. It requires source and live coverage for every feature; reading all pages alone is not a successful maintenance pass. Keep index entries, behavior IDs, entry points, preconditions, recipes, and Gotchas aligned with the product. A real product regression belongs in a reported product issue, not a rewritten claim that hides it.
