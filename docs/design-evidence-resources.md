# Resources redesign evidence

## Scope and order

Owned Files, Memory, Checklists and Apps presentation. Read the existing components, routes, contracts and recovery owners before designing. Read the project lifecycle standard and `docs/conversation-first-redesign.md`. No backend, hook, machine, persistence, authority or route ownership changed.

Executor catalogue and skills were read at Personal Skills revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`: `build-design`, `better-interface`, `better-layout`, `better-typography`, `better-accessibility`, `mobile-native`, `better-writing`, `better-colors`, `better-ui`. Re-read [Jakub's Less is more](https://jakub.kr/writing/less-is-more) live. Its application here is removal of duplicate tool links, revision badges, repeated live labels, counts and instructional chrome; recovery facts and user data remain.

The Paper guide, tokens, approved conversation shell JSX and available Geist weights were read first. Eight new boards were created and reviewed before the first implementation edit. JSX was extracted from all eight; computed artboard styles were captured. A later consistency pass updated the Paper tab treatment to the established shared segmented Tabs and corrected Paper text to explicit Geist because the font variable had resolved to the system fallback. Original approved screens were preserved.

## Paper

All boards are on [Build · Resources](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0), arranged in three columns: main Files/Memory, Checklists/Apps, and contextual mobile/recovery states. Existing pages were not deleted.

| Board | Surfaces |
| --- | --- |
| [01 Files](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J5L-0) | Collection, list selection, detail, attachment/download/options, Markdown preview/source, format disclosure |
| [02 Memory](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J82-0) | Search, saved notes, source disclosure, Notes/History/Summaries/Archive navigation |
| [03 Checklists](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J87-0) | Collection, creation action, progress, archived disclosure, task detail/actions |
| [04 Apps](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J8F-0) | Collection, publication status, version control, actual structured app controls, update disclosure |
| [05 Files states](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J8L-0) | Mobile drawer detail/back, upload progress/failure, rename, trash/restore and empty states |
| [06 Memory states](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J8T-0) | Mobile search results, summary navigation/provenance, export, backup, import and retry |
| [07 Checklist states](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J8W-0) | Mobile editing, title/notes/status/date, retained draft, conflict comparison, uncertainty, history and archive |
| [08 App states](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-F-0/1J93-0) | Mobile version preview/publication, form conflict, uncertain change, web reload and empty/archive/error |

Screenshot checkpoints covered each board. Verdict: consistent 16px group rhythm, readable 14px body/13px controls and 18px titles, aligned repeated lanes, restrained token-based surfaces, and no artboard clipping. The Memory result/empty contradiction was removed; mobile checklist status/date fields were added. Paper remains a static state specification; motion comes from the existing shared primitives and native responsive overlay runtime.

## Implementation

| Area | Changes |
| --- | --- |
| Files | Compact collection header and framed desktop explorer; narrow workbench shows list or detail with an explicit All files control. Full filenames wrap instead of becoming inaccessible truncated labels. Actions wrap, formats stay behind disclosure. Upload rows share the same compact surface. |
| Memory | One header, concise tabs, framed notes with source disclosure, searchable history and existing summary/recovery/import/export controls. Cache diagnostics are disclosed. No manual note editor was added because the product has none. |
| Checklists | Quiet list rows with navigation affordance, no implementation revision badges, compact framed detail/task editor, shared task controls. Retained drafts, comparisons, history, origin and archive/restore remain. Removed the redundant Live checklist badge. |
| Apps | Removed duplicate Checklists cross-navigation. Quiet list rows, shared framed content, 18px title, shared fields and publication controls. Version history, form conflict, retry/reconcile, iframe ownership and archive/restore remain. Removed infrastructure explanation from web-app toolbar. |

New feature styles: `src/features/files/files.css`, `src/features/memory/memory.css`, `src/features/objects/checklist.css`, `src/features/apps/apps.css`. They use existing semantic colors, radius, type and shadow tokens, rem spacing, logical edges and container queries. No palette, density or motion abstraction was added. Foundation owner removed superseded global resource selectors.

Common body/header chrome still uses `.workbench-body`, `.workbench-heading-row`, `.workbench-section-title`, `.workbench-title-menu`; workbench/root owner is moving those shared rules out of the legacy global file.

Files, Apps and Objects roots accept `active?: boolean` (default true). Resource content/owners remain mounted while inactive. Only transient menu roots/portals are reset; checklist origin dialog visibility is gated without closing its owner. Apps additionally project inactive into the existing disabled fence, so hidden forms/iframes cannot dispatch actions. Existing scoped Effect actors, immutable attempt identities and recovery semantics are unchanged.

Root review extended the native WebCanvas admission capability to inline apps in hidden conversations: the existing `FrameHost.current` now derives disabled from the actual iframe's client rectangles and inert/accessibility-hidden ancestry. Both existing bridge admission and effect dispatch already sample that capability, so no visibility state, observer, new machine or owner reset was introduced. Passive ready/height/render handshakes remain available. Restoring a visible host resumes normal actions and retains its unsent web draft.

## Verification

- Typecheck passed after the presentation changes, then passed again after root corrected its removed performance-fixture import.
- Focused lint passed across all nine changed resource TSX modules and the Apps retention fixture/test after two render functions were simplified with cohesive presentation helpers.
- `git diff --check` passed for the owned surface/test changes.
- Six focused unit suites passed: Files lifecycle, Memory import/query/resource ownership, Working Objects UI, Apps UI lifecycle — 45 tests.
- Existing Apps mounted browser checks passed on desktop and mobile (10 checks). The added retained AppView regression passed on both widths (2 checks), covering form values, iframe DOM values, hidden menu cleanup, inactive disabled state and unchanged resource read/render/write counts. It uses separate structured and web app documents because actual contracts prohibit combining a web block with other blocks. Invalid mixed-block fixtures and mismatched web preview IDs were rejected by the actual contracts while preparing this test.
- Hidden/inert native WebCanvas admission passed on desktop and mobile for display:none, inert, data-base-ui-inert and aria-hidden ancestors. Each case retains draft text and causes zero actions or extra renders, then a restored visible host accepts its normal action. The test sends a passive height event after the attempted action as an actor-delivery barrier. `BREAK_FRAME_VISIBILITY=1` removes only the native visibility projection in the test build; that negative control fails with one hidden action instead of zero.
- All 16 existing file-media browser checks passed after adapting its esbuild fixture to discard CSS imports (behavior-only bundle) and supply the actual FileDetails active prop. Microphone release, late permissions, native final audio data, transcript/preview fences, video cleanup and immutable rename/recovery behavior remain covered.
- Updated existing browser selectors for intentional label changes: Title, Notes, Archive and Root summaries. No behavior assertions were removed.

Integrated review used the actual local app at `http://127.0.0.1:4399`, isolated agent-browser session `resources-redesign-review`, at 1440×900 and 390×844. Browser-only read mocks supplied representative Files, Checklist and App documents; no application/provider data was written. Reviewed empty Memory and Files plus populated file, checklist, task editor and generated-app states. Screenshots are `/tmp/resources-{files,memory,checklist,apps}-*.png`. Mobile Memory rendered a 390px sheet with 16px input text and no document horizontal overflow. Desktop file list switches to detail-only in a narrow workbench; the wide explorer is reserved for an expanded pane.

The review found and corrected Files' unhelpful preview failure with a Retry preview button using the existing machine's OPEN event. Added `tests/browser/files-preview-recovery.spec.ts`: first read fails, retry reads the same file, and no mutation is sent. It passes desktop/mobile. The checklist editor now hides its disabled task rows/actions while editing, retaining DOM and owners; this matches Paper's focused editing state. Saved revision metadata was removed. Markdown preview heading hierarchy and generated-app control dimensions were aligned to Paper using existing tokens/utilities. Rebuilt the actual fixture into `/tmp/durable-resource-preview` and served it on isolated port 4479 for final proof.

The review also exposed expanded-workbench sizing: host widened but native Sheet stayed 480px. Root fixed the shared selector and added a width assertion to the workbench browser regression. This is recorded as an integrated shell finding, not a resource-owner change.

Long-content inspection exposed a second shared seam: the retained tool panel had lost its flex/min-height rule, so its content was taller than the available pane while an ancestor clipped overflow. Added `tests/browser/resource-layout.spec.ts`, using an actual eight-field AppView and read-only responses. It requires wheel scrolling to advance the resource body, the entire bottom action to enter the viewport, fixed tool controls to remain visible, and zero writes. The mobile test failed against the pre-fix served build at the bounded-scroll assertion; root restored the shared flex rule. The test now passes desktop/mobile. Restored attachment chip wrapping/gaps in `conversation.css` with that owner's authorization after the old global rule was removed.

Final resource suite on the isolated latest build: 10/10 passed across file preview retry, checklist uncertain creation, conflict/reapply, uncertain cancellation and long-form scrolling (both desktop and mobile). This found and corrected a summary flex regression that crushed the checklist conflict alert into a narrow column; the alert now takes the full row. No recovery visibility assertion was weakened. Final direct typecheck, scoped lint, formatting and diff checks passed.

Declared-token contrast checks (not claims about every runtime pair): foreground/white 14.68:1; muted/white 5.61:1; white/primary 5.50:1; input boundary/white 3.52:1; night muted/night surface 5.97:1. Existing shared controls provide focus, pointer sizing and reduced-motion behavior; no custom animation was added to frequent resource interactions.

At 320px the actual generated-app surface and document had no horizontal overflow. Scoped axe 4.12.1 returned zero violations, with three color-contrast nodes incomplete because of textured gradients or overlap; these are not reported as a blanket contrast pass.

Physical-device keyboard, safe-area and gesture behavior remain unverified without a phone. No production message, upload, approval, invitation or provider command was sent.

## Upload-owner readiness follow-up

The final full-browser run exposed a mobile startup gap: the native chooser existed before `useFiles` had published its scoped command owner. The trace recorded a file selection and only the initial file-list GET, with no upload POST. The hook's unowned upload closure returned without dispatching.

`FilesState.ready` now projects the existing correct-cache owner identity. File and voice controls remain disabled until that owner exists; the native chooser is exposed only then. Composer drag/drop admission uses the same projection. No production delay, pending-command queue, test hook or new lifecycle state/machine was added.

The standard browser suite discovers `tests/browser/file-controls-readiness.spec.ts`. Its test-only esbuild seam holds actual Effect owner publication, proving initial readiness, late pending-owner cancellation, and rebinding from an already published/uploaded alpha owner to a held beta owner. All six desktop/mobile readiness cases pass. The original PDF pending-extraction/durable-preparing reload test passes unchanged on both widths (two cases); all twelve file lifecycle unit tests pass.

Both negative controls fail at the intended disabled-control assertion: forcing readiness true exposes the startup gap; deriving readiness from any published live owner allows the former alpha owner to enable beta's controls. Production source is not mutated by these test-build controls. Final scoped lint, formatting, typecheck and diff checks pass.
