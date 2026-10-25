# F05 focused evidence

23 October 2026. These immutable logs describe the Browser/Execution UI candidate above `e521e98`. Source hashes and precise limits are in `source-manifest.json.txt`; the [implementation contract](../../../xstate-effect-tools-ui.md) describes ownership.

- Both original mounted React/Chromium probes failed on old source and pass unchanged on the candidate. All API requests are intercepted; this is no provider proof.
- Sixteen focused actor/native-boundary tests passed in two files. Scoped TypeScript and lint commands exited zero; their logs are empty on success.
- Production frontend build passed. The existing performance server separately built the browser fixture and all eight desktop/mobile journeys passed with zero retries, unchanged timeouts and one worker on isolated port4455.
- Three narrow negative controls failed at the intended assertions: stale Execution detail, cross-agent screenshot readiness and stale Close generation. The transformations affected temporary bundles only. Production source was unchanged.
- The generated route declaration produced by the build was preserved under `/private/tmp/f05-tools-ui/routeTree.generated.ts` and restored to exact HEAD. No shared config, package, backend, storage migration, Git, provider, merge or deployment action was performed by this lane.

Full repository and hosted CI gates remain separate.

The independent Execution review added actual mounted React/Chromium selection and agent ABA probes, hidden polling, and direct HTTP-owner cleanup/retry probes. All passed with unchanged hashes. The parent independently reread both domains and reran all sixteen focused tests without a concrete finding.
