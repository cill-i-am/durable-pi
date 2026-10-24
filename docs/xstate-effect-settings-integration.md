# Current-main settings integration

The lifecycle stack was rebased from `696aca98000a6e82a9cb202acc18f92f2c8e987e` onto `1f800d419d1823de1bda960721d89964ae06a492`. The newer main introduces global settings routes, separate personal libraries and agent assignments, native nested drawers, and upstream idle heartbeats. Earlier CI links remain historical evidence for their recorded commits. They do not establish checks for the rebased heads.

## Preserved behavior and ownership

- The upstream diagnostic machine owns the idle heartbeat invocation. It retains the original sixty-second observation deadline and joins stream cancellation and peer release. Two clock tests verify pulses, early close and expiry.
- Connection and skill libraries omit agent-selection reads. Their machines and HTTP capabilities refuse assignment commands; agent views refuse library mutations. Current-main library links, pinned skill revisions and embedded account security remain intact.
- WhatsApp settings read the global configuration and display all agents' replies. Each request captures its target agent together with its existing operation ID. The version-one session receipt accepts older requests without an explicit target; newer requests retain their target through schema decoding, confirmation, failed acknowledgement, restoration and explicit retry. No routing failure creates another send authorization.
- Agent model defaults retain their own save/reconciliation machine. The separate family Model access page owns sign-in. Sign-in request errors and return-address drafts retain the navigation guard until explicitly handled. A catalog failure after a successful default save now has a `Reload models` action that reads without another write.

## New main-owned drawer lifetimes

`settings-drawers.machine.ts` replaces the rendered-array setter and the deferred exit boolean/ref sequence. Route changes retain outgoing native bodies until their matching close acknowledgement. A revision rejects obsolete acknowledgements; only root closure dispatches the captured exit. The host rechecks the current URL, navigation lock and mount authority at dispatch. A route observed during dispatch is retained after completion. Router owns history and destinations; Base UI owns native focus, animation and gesture mechanics.

`settings-owner.machine.ts` selects the agent component retained while its outgoing settings stack closes. Its host keeps only current/retained render data keyed by the machine-selected identity. `workbench-presence.machine.ts` also retains the underlying workbench while settings remain shown. No writable legacy close or retained-owner decision remains beside these machines. These are local scopes, with no persisted snapshot, schema migration, retry or new durable engine.

The focused drawer/model tests pass 39 cases. Removing revision validation in an isolated test transform makes the stale-acknowledgement test fail; the normal implementation passes. The new-main browser baseline passed 20 applicable journeys. The first composed run passed 48, skipped six desktop instances of mobile-only cases, and exposed four failures: the two viewport instances of an obsolete Model access URL and a missing model-catalog reload control. The URL fixture and recovery control are corrected; the complete browser gate is running. The mounted skills component separately passes all eight desktop/mobile cancellation, exact retry, conflict and import journeys.

Static checks and all 3,918 unit tests in 334 files pass at the integration checkpoint. Website routing and all seven Workers build. All fifteen native recovery suites, both container builds, 29 mounted-component cases, actual passkeys and two-build recovery pass. The [raw evidence and source hashes](evidence/xstate-effect/main-integration-2026-10-24/README.md) retain the initial browser fixture failures and a concurrent-build harness interruption; a complete isolated browser rerun remains in progress. All 27 prior PR heads are republished unsigned against current main. New drawer publication and refreshed hosted checks remain open. No merge, deployment or live-provider result is claimed.

## Census delta and retained mechanisms

The prior inventory remains the responsibility map. The current-main source delta and a fresh scan of all source paths identify the drawer owners above as additional application progression. The scan is a discovery index, not a substitute for the ownership review or behavior tests.

| Reviewed path | Retained responsibility |
| --- | --- |
| `src/navigation/settings-stack.ts`, `src/app/use-workspace-location.ts`, new settings route files | Pure URL/history validation and native Router calls. Deferred close-to-navigation is in the drawer machine. |
| `src/app/workspace-settings.tsx` | Child pending facts are projections. Native mount/animation flags, focus elements and destination caches are presentation; they cannot independently authorize the captured exit. |
| `src/app/workspace.tsx` | Child pending values project their owners. The lazy-module loaded latch caches whether settings were loaded; drawer and agent machines decide retained bodies and close progression. |
| `src/features/whatsapp/whatsapp-settings.tsx` | Chosen agent is form data; pending is the request owner's projection. The immutable request owns the target used for every retry. |
| `src/features/family/family-join-owner.ts` | The generation identifies the external invitation; AbortControllers are request resources. The join machine decides verification, preview, acceptance, recheck and navigation; the host additionally fences late external results. |
| `src/terminal/{host,native-host}.ts`, `src/terminal/adapters/socket.ts` | Existing machines decide admission, occupancy, migration and close. Promise maps retain join handles. Relay listeners and its idempotent native socket cleanup implement the admitted session capability. |
| `src/memory/adapters/http.ts`, `src/conversations/adapters/latency.ts` | Native response-body demand/cancellation, bounded framing and read-only timing instrumentation; existing host owners retain and join the work. They do not admit another business attempt. |
| `src/workspace/attachments.ts`, `src/features/activity/use-plans.ts` | One admitted work invocation prepares/project files or joins a batch of reads. Durable Workspace and Activity query machines retain retry and observation progression. |
| `src/hooks/interaction-sound-resource.ts`, `src/features/rich-results/places-map-resource.ts`, `src/browser/adapters/cloudflare.ts` | Effect scopes retain native nodes, maps and disconnect handles under their existing feature/connection machines. Native resource flags prevent duplicate cleanup; they do not select the next business step. |

Complete integration gates and the rebased-head crosswalk must be recorded before closing the repository-wide goal.
