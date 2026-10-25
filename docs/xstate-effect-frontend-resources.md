# Frontend resource lifetimes and draft admission

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

F15 implementation record, 23 October 2026. PlacesMap, interaction sound, syntax loading, and question draft admission now use the official XState/Effect integration. Each component owns an Effect scope; machines decide progression and Effect owns native work and cleanup. The [source manifest](evidence/xstate-effect/f15-source-manifest.json.txt) identifies the 16 source/test files above `2c13994f478c38f9549000eaa13106df4c94203b`. Package pins, preference storage, and the shared React architecture are unchanged. This local record does not establish hosted CI, merge, or deployment.

## Ownership and behavior

| Lifecycle | Machine and Effect boundary |
| --- | --- |
| Map | [`places-map.machine.ts`](../src/features/rich-results/places-map.machine.ts) tracks desired/current revisions and opening, loading, ready, fallback, releasing, unavailable, and blocked states. [`places-map-resource.ts`](../src/features/rich-results/places-map-resource.ts) retains one native lease across loading and ready. A replacement waits for the explicit close result; failed cleanup blocks reacquisition. Later configuration changes during release retain only the latest desired view. |
| Sound | [`interaction-sound.machine.ts`](../src/hooks/interaction-sound.machine.ts) owns admission, acquisition, suspended resume, mute/state recheck, and tone completion. Independent activation actors preserve overlapping clicks. The component owns a lazy shared AudioContext; scoped tones release nodes/listeners before joined context closure. Resume observation can be interrupted without waiting for a gesture-blocked promise; closed ownership fences late results. Tone and shutdown cleanup failures remain observable. |
| Syntax | [`highlighted-code.machine.ts`](../src/hooks/highlighted-code.machine.ts) owns the current language-load observation. A new language replaces the invocation and clears the result; the hook also compares the render language before using a snapshot. Unsupported/failed loading leaves plaintext. Components borrow the existing shared Shiki cache and do not dispose it. |
| Question | [`question.machine.ts`](../src/features/rich-results/question.machine.ts) admits one immutable draft append per edit revision. Repeated clicks during/after admission do not append again; editing permits another append. A failed append preserves choices and permits explicit retry. The actual callback preserves existing composer text and does not send a message. |

All four validate machine events at runtime. Controlled tests exercise malformed inputs, stale observations, interruption, and failure paths. React effects own the actor/subscription and forward inputs; writable legacy status branches are removed.

Map, marker, listener, and ResizeObserver releases are registered immediately after acquisition. The existing `nativeOperation` joins module loading during interruption. A failure after constructing the map therefore releases it even when setup never completes. Route preparation runs inside Effect after load. The 15-second fallback now covers the whole attempt, including module loading, and retains late-load recovery. Accessible addresses, directions, and the selected-place fallback remain available. Default initial selection preserves the fit-to-all camera; a non-default selection restores focus after replacement.

## Source-backed exclusions

[`gallery.tsx`](../src/features/rich-results/gallery.tsx) owns independent weather selection and delegates tab behavior to the UI SDK. It owns no image-fetch/object-URL lifetime. Its synchronous draft callback remains unchanged. Selected map cards, question choices/text, and the incremental highlighted-line/grammar cache remain plain view/form values or synchronous derived rendering. Shiki's shared module cache remains the existing library capability; this change does not redesign concurrent cache loading or sticky initialization failure.

## Failure-sensitive evidence

The [original map regression](evidence/xstate-effect/f15-map-original-red.log.txt) failed because control acquisition threw after map construction and `remove()` was never called. The [map negative control](evidence/xstate-effect/f15-map-negative.log.txt) removes only immediate map cleanup and fails the regression again. The [sound negative control](evidence/xstate-effect/f15-sound-negative.log.txt) removes oscillator disconnect and fails after gain acquisition throws. Both mutations were restored before final checks.

The [first targeted browser run](evidence/xstate-effect/f15-browser-camera-red.log.txt) exposed a mobile camera regression: selecting the default first marker immediately after fitting all places moved the second marker outside the viewport. The correction preserves the initial fit; [16 targeted journeys passed](evidence/xstate-effect/f15-browser-focused.log.txt), followed by the complete browser gate with two additional map-fallback cases.

## Local verification

Checks use Node 24 and the frozen offline dependency installation. Default test timeouts and zero browser retries are unchanged. Final results are recorded below; native backend and hosted CI remain separate gates. The final [documentation format check](evidence/xstate-effect/f15-format-final.log.txt) and [proposed-file credential scan](evidence/xstate-effect/f15-proposed-scan.log.txt) also pass; the latter includes untracked candidate additions.

| Check | Result and evidence |
| --- | --- |
| Full static | Passed: credential scan of tracked files, route generation, migration manifest, typecheck, lint, and format ([log](evidence/xstate-effect/f15-static.log.txt)). |
| Full unit | 2,705 tests passed in 246 files with two workers ([log](evidence/xstate-effect/f15-unit.log.txt)). |
| Production build | Passed on the corrected source ([log](evidence/xstate-effect/f15-production-build.log.txt)). |
| Worker/site-route builds | All seven Worker entrypoints built ([log](evidence/xstate-effect/f15-workers.log.txt)); actual built family/diagnostic routes passed ([log](evidence/xstate-effect/f15-website-routes.log.txt)). |
| Full browser | 84 desktop/mobile journeys passed ([log](evidence/xstate-effect/f15-browser-full.log.txt)). |
| Built passkeys | Passed registration, password-free sign-in, device proof, origin/replay/freshness, rename/removal, and private native auth ([log](evidence/xstate-effect/f15-passkeys.log.txt)). |
| Two real frontend builds | Retired-asset recovery preserved draft/file references with zero submissions ([log](evidence/xstate-effect/f15-client-upgrade.log.txt)). |

Browser journeys run actual MapLibre with controlled style responses, prove replacement/selection/unmount and failure fallback, and use actual syntax highlighting plus unsupported-language plaintext. The audio journey uses native AudioContext, pointer and keyboard activation, explicit suspension/resume, mute, preview, and context cleanup. A separate journey injects blocked audio and failed preference writes. Existing question coverage proves the actual append preserves composer text without sending; duplicate/edit-revision admission is controlled unit proof. No live map-provider or model behavior is claimed.

An [independent read-only review](evidence/xstate-effect/f15-independent-review.txt) found no concrete issues across all four final lifecycles. Native resume/close overlap remains simulated-barrier proof; the real browser separately proves suspended resume. Injected-loader tests establish language observation fencing, not concurrent shared-Shiki initialization or a mounted-hook language race. Generated route declarations and screenshots are excluded from the candidate.
