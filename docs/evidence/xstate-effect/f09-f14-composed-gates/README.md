# Composed F09–F14 checks

Final static checks pass above `231b1c44ee8dd9a000eddd92cb12ffc0125cda28`. The complete unit/build gate passed 3,655 tests in 325 files plus the production website and Worker builds. After the caller scan confirmed the legacy polling helper was unused, its implementation and two tests were removed: the final unit run passes 3,653 tests in 324 files. No executable caller changed in that removal.

The full browser gate passes 246 desktop/mobile Playwright journeys, 29 mounted-component cases (Skills 8, Memory 12, workspace controls 9), real SDK passkey ceremonies with synthetic accounts and two real frontend builds for retired-asset recovery, draft preservation and zero unintended submissions. The portable component probes are now part of the required `verify:browser` script. No provider/model call or production mutation is represented by these fixtures.

The first unit run failed five unchanged delegation-caption assertions. Actor restoration had incorrectly displayed Sending before a request began. The UI now projects a separate sending state for captions while retaining the original blocked/busy admission rules. All nine unchanged presentation tests and the complete repaired gate pass. The route-error retry's new regressions failed before the accumulated cleanup Cause repair and pass afterward; both runs are retained.

Generated route registration and incidental asset directories were preserved outside the checkout. Final static checks ran after restoring the checked-in route declaration. Backend sources match the preceding frontend stack; native runtime CI is required on publication. No hosted CI, merge or deployment success is claimed here.
