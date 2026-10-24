# F07 Objects UI evidence

The [contract](../../../xstate-effect-objects-ui.md) describes ownership, compatibility and limits. `source-manifest.json.txt` records exact source hashes and evidence hashes for the local source-freeze checkpoint.

- `before.log.txt` / `after-final.log.txt`: unchanged three-case store counterexample, original red and migrated green.
- `agent-view-red.log.txt` / `agent-view-final-green.log.txt`: unchanged mounted React/Chromium agent-switch counterexample using original-source bundle injection.
- `unit-final.log.txt`: 18 focused tests, including real SQLite/Pi recovery and native held-request cleanup.
- `browser-final.log.txt`: six desktop/mobile journeys against the isolated synthetic fixture.
- `negative-*.log.txt`: expected assertion failures from temporary transformations; no production mutation.
- Type/lint/format outputs and configs record the scoped checks. Empty type/lint files mean successful exit with no diagnostics.

No external provider, deployment, Git mutation or hosted CI claim. Independent review is pending at this checkpoint; broad gates belong to the parent.
