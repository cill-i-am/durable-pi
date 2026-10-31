# Shared UI foundation evidence

This records the shared foundation only. Route-specific Paper, implementation and browser proof belongs to each surface owner's evidence file. No merge, deployment or production verification is implied.

## Design source and sequence

Read Executor's `executor` skill and visible `skills({})` catalogue, then `personal-skills/build-design` and `personal-skills/better-ui` at revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Read the local shadcn and agent-browser skills. Applied [Less is more, more or less](https://jakub.kr/writing/less-is-more) by removing the competing theme and duplicate visual implementations while preserving necessary ownership and completion seams.

The existing approved [UI primitives page](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-A-1) was inspected before source edits: current Paper guide, artboard inventory, token export (`fc280747`), JSX, computed button styles, and screenshots for Buttons (`186M-1`), Cards & frames (`19KC-0`), and Stacked drawers (`18OJ-1`). The shell's [Conversation First page](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1) remains the composition contract; this foundation does not invent another shell.

| Element | Paper / approved shared convention | Actual app rendering |
| --- | --- | --- |
| Sans family | Geist | `"Geist Variable", sans-serif` |
| Primary | `#535FC6` | `rgb(83, 95, 198)` |
| Foreground | `#28282C` | `#28282c` |
| Input boundary | `#888890` | `#888890` |
| Control radius | 10px | 10px |
| Default label | 14px | 14px |
| Default button height | 44px touch; compact shared fine-pointer desktop convention | 44px at 390px; 36px at 1280px |
| Card depth | Quiet border and 2px/6px shadow; neutral inset frame | Shared Card / CardFrame definitions, no app primitive override |
| Mobile drawer | 24px top corners; 24px handle strip; native stacked layers | Shared overlay CSS with app-owned native Drawer controller |

Visual checkpoint: neutral surfaces, restrained purple primary, aligned controls, readable labels, and visible nested drawer edges. The isolated preview has no horizontal overflow at 390px. Preview composition is a temporary verification fixture, not a route design.

## Implementation

- `src/styles.css` imports `@workspace/ui/globals.css`. Removed its Inter import, independent Tailwind theme, light/dark palette, black primary, generic radius/type declarations and competing base styles. Removed superseded shell, navigation, startup, chat, workbench-frame, auth, settings, family and resource rules after each owner confirmed its replacement stylesheet. The file is 229 lines, down from 3,363. Global avatar sizing was removed so the shared Avatar size prop owns its graphic and frame together.
- `packages/ui/src/styles/globals.css` is the single app/Storybook theme. Added semantic sidebar, chart, terminal and existing Paper accent roles used by the app, plus temporary aliases for existing app surfaces. These derive from the approved palette; they do not create a second app theme.
- `packages/ui/src/components/button.tsx` accepts `xs` and `icon-xs` as compatibility aliases of the existing `sm` and `icon-sm` recipes, preserving 44px touch targets. Its exported class recipe and rendered Button share the same class merging. Native disabled/static/reduced-motion attributes gate press feedback without changing the exported layout class contract.
- `src/app/workbench.css` owns the common resource toolbar and scroll body: 16px heading/body insets and gaps, 16/24 headings, and contained body scrolling.
- `packages/ui/src/components/toggle-group.tsx` keeps icons and labels together in one inline flex label; a geometry regression check verifies horizontal alignment and one-line labels.
- `packages/ui/src/components/tooltip.tsx` defaults its popup to `role="tooltip"`; installed Base UI 1.9 no longer supplies that role. Native tooltip presence/open/close remains unchanged.
- Generic photo Avatar remains local: the package only has stable-seed `AgentAvatar`, which is not API-compatible with AvatarImage/Fallback.
- App imports now use `@workspace/ui` directly. The eighteen forwarding and temporary compatibility modules were removed after migrating their consumers; ignored size/variant props were removed rather than retained in adapters.
- Custom chat, input-group, command, sidebar and other primitives with no package equivalent remain in place.

## Retained behavior seams

| App module | Required behavior |
| --- | --- |
| `responsive-overlay.tsx` | Retains `desktop="panel"`, nonmodal desktop docking, nested layer context, mobile gestures, and the mounted native Drawer tree. Uses package CSS and class handling, including reduced-motion attributes. Mobile retains explicit native stack layers; desktop restores the common native portal layer so later menu/select portals receive pointer events. |
| `dialog.tsx`, `sheet.tsx`, `alert-dialog.tsx` | Use shared visual composition against the local overlay context. `SheetContent.keepMounted` forwards to its portal so tab content can survive close. |
| `responsive-popup.tsx` | Retains inherited `afterClose` action storage and `onOpenChangeComplete`; adds package-compatible keyboard/final-focus props. |
| `dropdown-menu.tsx` | Package visual recipes with the app's `usePopupAction` completion ordering. `portalContainer` optionally places a desktop menu within its native parent drawer; mobile path is unchanged. |
| `select.tsx` | Preserves app dismissal/admission behavior with package visual recipes; accepts old trigger `size`/`variant` props during migration. Restored the desktop positioner portal layer and wired native Tab close through the SDK action ref. |

Do not replace the local menu/overlay modules with package reexports until the package supports the panel API and deferred-after-close action seam. Styling equality alone does not prove behavioral compatibility.

## Verification

All commands use `npm_config_manage_package_manager_versions=false`.

- App `pnpm typecheck`: passed.
- Existing button/link class parity and shared-theme contrast regressions: 13 passed. Contrast assertions now read the canonical shared stylesheet and handle shorthand hex colors without changing thresholds.
- Shared package `pnpm --filter @workspace/ui typecheck`: passed.
- `pnpm test:ui`: 24 tests passed across two files.
- `pnpm build:storybook`: passed. Existing bundler module-directive/chunk warnings remain.
- Focused shared Playwright suite (`button sizes`, `primitive density`, `theme`, `keyboard`, `drawers`): 38 passed, two expected project skips across desktop/phone and light/dark. Log: `/private/tmp/foundation-ui-browser.log`.
- Shared press reversal, disabled/static behavior, live reduced-motion updates and icon-label layout regressions: 12 passed across desktop/phone and light/dark. Log: `/private/tmp/foundation-shared-motion-layout.log`.
- Shared tooltip browser stories after the role fix: 24 passed, including keyboard focus and Escape, across desktop/phone and light/dark. Log: `/private/tmp/foundation-tooltip-browser.log`.
- Existing actual-app provider-free `tests/browser/workspace-controls-lifecycle.mjs`: nine checks passed, including native command focus return at 1100px and 390px, late-result fencing, explicit recovery and locked search. Log: `/private/tmp/foundation-app-controls.log`.
- Actual-app desktop WhatsApp channel ownership regression: passed, including selecting the target assistant from the settings drawer after verifying the option receives the real pointer hit. Log: `/private/tmp/foundation-channel-browser.log`.
- Actual-app provider-free performance fixture build: passed into an isolated temporary output. Log: `/private/tmp/foundation-app-build.log`.
- Scoped Oxlint, formatting checks and `git diff --check`: passed.

An isolated local Vite preview imported the actual app CSS and local primitive modules. At 1280px and 390px, agent-browser inspected/screen-captured the controls. On mobile it edited a draft, opened a nested select, chose the second option, returned with the draft intact, opened/returned from a nested sheet, dismissed with Escape, and selected a menu action that successfully opened its next drawer after close. No provider calls, real messages or other external mutations were used.

Comparison captures:

- `/private/tmp/durable-pi-foundation-buttons.png` — shared button state matrix.
- `/private/tmp/durable-pi-foundation-app-desktop.png` — actual app theme/primitives at 1280px.
- `/private/tmp/durable-pi-foundation-app-mobile-drawer.png` — 390px drawer.
- `/private/tmp/durable-pi-foundation-app-mobile-select.png` — stacked mobile select.
- `/private/tmp/durable-pi-foundation-app-mobile-nested.png` — nested sheet.
- `/private/tmp/durable-pi-foundation-app-mobile-deferred.png` — deferred menu-to-drawer result.

These checks establish the shared foundation and retained native behavior. Full route verification and final repository gates remain the root task's responsibility.
