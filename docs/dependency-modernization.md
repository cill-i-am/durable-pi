# Dependency and infrastructure modernization

Prepared on 18 November 2026 with an initial baseline at main `9a54955246892aeda00ec736ff6c45f3be2d6543`, then rebased onto `2a1ac6cb1b939d7f5553d8c659a327cd060b305f`. This records source changes and local validation. It is not a production deployment record.

## Dependency policy

Both workspace manifests and their shared lockfile were audited against registry metadata. Production dependencies, development tools, the UI package and pnpm were included. Updates stay on each deliberately selected release channel: XState's current alpha channel and Drizzle's current release candidate, for example, rather than downgrading to the older major published under `latest`. The separately published XState/Effect beta pair is not adopted in this change.

| Group | Selected versions |
| --- | --- |
| Alchemy and provider packages | 2.0.0-beta.87 |
| Effect and platform/SQL adapters | 4.1.4 |
| Agents | 0.33.0 |
| Pi AI, Durable, Schema and Chord | 1.5.2 |
| XState / official Effect integration | 6.0.0-alpha.73 / 1.0.0-alpha.12 |
| Drizzle ORM / Kit | 1.0.0-rc.5, already current on the RC channel |
| Cloudflare browser SDK | 2.0.1 |
| Workers types / native workerd | 5.20261117.1 / 1.20261117.1 |
| Vite / Vitest / Playwright | 8.3.8 / 5.1.0 / 1.65.1 |
| React / Storybook | 19.3.1 / 10.6.7 |
| pnpm | 12.21.0 |
| pnpm setup action / cccc reporter | 6.1.1 / 1.9.1 |
| Native terminal base image | Node 24.22.3, pinned by registry digest |

The production Sandbox SDK stays at its current 1.0.3 release. The intentionally old `@cloudflare/sandbox-v0` alias and matching 0.12.14 image remain available for migration rehearsals. They must not silently become the production SDK. Existing MCP 2.4.0 and Zod 4.6.7 fixes remain covered by the package and concurrency tests. The Agents storage-coordination patch is rebased onto 0.33.0.

Alchemy beta.87 supplies the rolldown dependency and Drizzle peer contract that previously needed workspace workarounds. Those overrides are removed. Chord 1.5.2 declares exact React 19.3.0 and ws 8.21.0 peers; compatibility allowances are restricted to that Chord release and the tested React 19.3.1 / ws 8.23.0 versions. No global peer-range widening is needed.

One catalog entry aligns direct and transitive workerd versions. Alchemy's `unenv` dependency is restricted to rc.24 to match its Cloudflare preset's exact peer contract; Wrangler already uses that version. Transitive dependencies were refreshed within their declared ranges with pnpm's release-age policy intact. Native pruning removes release-age exceptions for versions absent from the lockfile. GitHub Actions retain exact commit pins.

The production-dependency audit fell from eleven advisories after the direct upgrades to two after the transitive refresh. Remaining findings are [picomatch's unpatched repeated-extglob denial of service](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) and [minimatch's globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249). The former is present through build tooling; the latter remains in shadcn's ts-morph dependency, whose range excludes the fixed major. No application source directly imports either matcher. This is dependency-path analysis, not proof that every transitive call is unreachable. No advisory is suppressed and no incompatible major is forced into an upstream range.

## Infrastructure design

The composition root selects state and yields the website and channel Workers. [Resource modules](../stacks/README.md) own storage, supporting services, terminal infrastructure, the agent host, channels and the website. Runtime environment types come from the module that owns their Worker. Rehearsal stacks no longer import the production entrypoint.

This follows Alchemy's guidance to keep the [entrypoint small and colocate related infrastructure](https://alchemy.run/project-structure/file-layout/) while respecting its [phase separation](https://alchemy.run/infrastructure-as-effects/phases/) and [resource identity and lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle/). The implementation was checked against [the beta.87 changelog](https://github.com/alchemy-run/alchemy/blob/v2.0.0-beta.87/CHANGELOG.md), rather than assuming every current website example exists in the pinned release.

Offline compilation of the old and new definitions compared all 13 resources in production and development: logical IDs, types, output dependency expressions, bindings, properties, modes and removal policies agree. Compilation used only fixture configuration, in-memory state and empty provider layers. It did not invoke provider reconciliation, build a remote container, contact Cloudflare or modify remote state. Existing resource IDs, durable classes, domains, private exposure, compatibility dates, migrations and state selection remain intact.

## Runtime migration and cleanup

Pi tools now use `@earendil-works/pi-schema`. Native conversation watches provide immutable views; a small adapter projects the SDK-owned live document into reply and activity data. The archive reader pages through the captured tail when the watch has older entries, so the new default 50-entry window cannot truncate history or include subsequent writes. First-text diagnostics also recognize committed output when the watcher folds away its partial updates. A redundant, unused Promise reply reader was removed; the scoped observer remains the production owner.

The recorded-storage fixture forwards Pi's batched commit receipts in their original order. Harness reports use the new report object, and native fixtures forward PiHarness's `onWake` hook. Production already forwards that hook and enables bounded retries. A killed model request now consumes that retry budget; delivery retry still does not create a new business operation.

The actual Pi 1.4 fixture in [the upgrade test](../tests/pi-upgrade.test.ts) retains its SQLite tables, indexes, completed tool receipt and pending generation. Pi 1.5.2 reopens it, retains both submission identities, resumes the pending request and executes the completed mutation zero additional times. Another native-harness test reads 280 originals through the bounded watch and excludes a later append.

Activity pagination explicitly consumes duplicate refresh events while reading, preventing them from falling through to the parent transition. Lint uses Effect's [supported `effect-tsgo oxlint` launcher](https://github.com/Effect-TS/tsgo#run-the-patched-tools-without-patching); positive and negative CLI conformance tests use the same entrypoint. An unused Files-panel barrel export was removed so its dynamic import creates a separate chunk.

Better Auth 1.7.25 enforces required device verification in both native passkey ceremonies. Duplicate application verification callbacks and an authentication-options response rewrite were removed. The browser proof retains real signed assertions from a virtual authenticator and verifies the SDK's native rejection codes, absent session and unchanged credential count. Uncertain mutation recovery remains conservative.

## Deployment and rollback

Pi 1.5 keeps SQLite schema version 2 but writes newer live-document and native task versions. An older Pi 1.4 runtime cannot safely resume those newer records. Pi 1.3 also cannot open SQLite schema version 2. Application workflow versions and accepted historical library identifiers are retained; this does not make a code-only Pi downgrade safe. Before an authorized rollout, use a restorable state backup and review the authenticated Alchemy plan, including any shared state-service upgrade. Never switch an existing deployment to an empty state backend.

## Validation

The reproducible verification entrypoints are:

- `pnpm install --frozen-lockfile` and `pnpm peers check` for the resolved dependency contract.
- `pnpm verify` for static checks, all 4,008 unit tests, website and Worker builds, native workerd restoration, desktop/mobile browsers, passkeys, stale-client recovery and both Linux container images.
- `pnpm --filter @workspace/ui typecheck`, `pnpm test:ui`, `pnpm build:storybook` and `pnpm test:ui:browser` for the separate UI workspace.
- `actionlint` and `pnpm complexity:report` for the workflow and code report.

Provider configuration is checked using synthetic credentials only. Hosted deploy/reconciliation, live provider requests and real-device passkey acceptance are outside these local checks. Native recovery fixtures exercise actual workerd processes, SQLite and alarms, with synthetic model and external-service responses.

The Files panel now forms a deferred 14.32 kB JavaScript chunk (5.17 kB gzip). Other size changes are mixed: the local AgentWorker bundle shrank 1.11%, total client JavaScript grew 0.51%, and Email/WhatsApp bundles grew 11.91%/12.70%. These compare local builds with the initial baseline above; Worker figures are raw esbuild output, not uploaded artifact sizes. They do not establish faster production startup or lower cloud costs.
