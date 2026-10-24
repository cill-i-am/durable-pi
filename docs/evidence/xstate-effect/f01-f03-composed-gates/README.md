# Combined F01–F03 checks

The final composition passed static checks, 3,422 unit tests in 302 files, production and seven Worker builds, all 15 native runtime suites, 144 desktop/mobile browser journeys, native passkey checks and two-build upgrade recovery with zero submissions.

The initial unit gate had one fake-timer synchronization failure; the test-only repair leaves all assertions and the five-second timeout intact. The earlier browser run had three desktop timeouts; the unchanged targeted rerun and final full run passed. Those original failures remain diagnostic evidence, not passes. Passkey origin-rejection logging is an expected negative control.

The terminal sessions were unavailable after the usage interruption. Completion was recovered from the saved command output: all 15 native commands ran through their success markers, and the browser sequence reached its final upgrade success and cleanup marker. No new test run or captured shell exit code is claimed for this recovery.

These local synthetic/native checks do not establish hosted-provider behavior or deployment. Hosted CI and publication are separate gates. The original source/evidence package is retained unchanged beside this directory.
