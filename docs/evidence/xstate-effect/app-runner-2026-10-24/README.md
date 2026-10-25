# App runner evidence

The source manifest records the final implementation/test hashes on top of host-census commit `90c130b`. Raw logs retain original whitespace.

- The preceding adapter fails both held-pump regressions: same-object callback overlap and premature lease exhaustion. All 19 final lifecycle tests pass, including queued scheduling/close, joined native failures with preserved annotations and malformed events.
- The first extended run exposed admission-refusal errors being counted as cleanup failures. The corrected host keeps the caller's late-lease refusal outside its retained native operation; the same test passes without relaxing assertions.
- Removing the App runner's PersonalAgent shutdown join fails the real native host ordering assertion. The positive full native suite passes. The final native log follows a fixture-only extraction required by the complexity check.
- The native Apps restart/no-object-request test passes with exact receipts and bounded recovery. Its original JSON evidence is retained.
- Final static checks, full unit suite, website/Worker builds and route checks are recorded in their named logs. The first static attempt failed the fixture complexity check; the helper was extracted without changing the probe.

Hosted CI remains separate from these local results. The composed parent's full browser and container gates remain scoped to their recorded source; this change affects no frontend or container source. Six further runner lifetimes remain open. No merge, deployment or live provider effect is claimed.
