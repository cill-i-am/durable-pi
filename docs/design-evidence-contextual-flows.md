# Contextual flows

The seven remaining overlay flows were explored in Paper before implementation. They remain on the single [Conversation First · Refined workspace](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1/1MM5-0) page, under **11 · Contextual flows**. Alternatives are retained under **10 · Explorations**. Existing sections and design tokens were preserved.

## Council decision

Five independent reviewers considered navigation, visual craft, mobile interaction, lifecycle ownership and adversarial minimalism using the shared UI skills. They compared three rendered result presentations: inline, companion workbench and full-width workbench. The selected model uses all three as explicit states of one flow:

1. Show the useful answer in chat.
2. Open its editing surface in a companion workbench only when requested.
3. Expand that workbench explicitly when the task needs more room.

The council agreed on this progression rather than a competing result modal. A result has one actionable editing surface at a time. Hiding its tab retains it; closing the tab returns its retained values to the inline result. Private drafts and output never enter its URL.

## Selected surfaces

| Flow | Desktop | Phone | Paper reference |
| --- | --- | --- | --- |
| Create/edit assistant | App-shell page, framed form, one primary action | Native bottom drawer; same mounted fields, scrolling body and safe-area footer | `1MMJ-0`, `1MNT-0`, `1MU4-0` |
| Interactive result | Persistent result-specific workbench tab, optional expansion | Existing native workbench drawer | `1NK4-0` |
| Saved activity | Detail inside Activity; Back preserves list/filter/cursor | Native child drawer above Activity | `1MUM-0`, `1NG5-0` |
| Checklist source | Local disclosure below the checklist | Native child drawer above the checklist | `1ND0-0` |
| Answer examples | Explicit Examples workbench tool, sample marker, draft-only actions | Existing workbench drawer | `1N43-0` |
| Add filter | Anchored nonmodal popover; field-local validation | Native nested drawer | `1MXA-0`, `1N7Q-0`, `1N8X-0` |
| People | Anchored popover with actual participants and subtle role badges | Native bottom drawer | `1MP3-0`, `1N23-0` |

The existing semantic palette, Geist type scale, tactile buttons and framed cards remain. Paper values were mapped onto existing primitives: 14px frame radius with a 3px inset, 10px inner card radius, 320px contextual popovers, compact desktop controls and mobile 44px targets with 16px inputs. No theme, dependency or density abstraction was added.

## Ownership and recovery

Assistant saves retain the original editor machine, immutable request and uncertainty behavior. Native Drawer retains mobile presentation, focus and keyboard ownership while the desktop page shares its actual fields. Dead standalone settings/security overlay fallbacks were removed; existing shell pages own those destinations.

Recorded result reads use the existing authorized Activity query owner. Existing workbench machines own tabs, expansion, closing acknowledgement and native focus-return intent. A user/assistant-scoped view cache retains independent filter, sort, pagination, shortlist and question values. It contains no commands or lifecycle snapshots. Map cleanup remains with the existing map owner.

Saved activity and source conversations are historical reads. Hiding a retained surface interrupts its observer without issuing a remote cancellation. Inspecting a checklist source leaves its unsaved task form mounted. Examples can append to the current draft but cannot submit it.

## Review and verification

Independent source review checked result identity validation, authorized recovery, assistant/user isolation, native focus fencing and draft-only actions without finding a material defect. Browser and visual review caught two editor layout errors: shared sheet positioning and a retained `display: contents` child consuming page height. Both were corrected, with explicit top-of-inset and footer visibility assertions added.

Runtime proof is kept separate from static Paper states. The focused browser journeys cover real field identity through resizing, native modal isolation and focus wrapping, short-height footer visibility, uncertain-save retry, result promotion/hide/expand/close retention, deep-link recovery, filter validation, Activity return history and checklist source recovery with an unsaved draft. Surrounding settings, authentication, route ownership and retained-workbench journeys remain repository gates.

The browser uses disposable synthetic transports and real application components. Physical-device keyboard behavior, a screen-reader session and production deployment are separate verification layers; they are not claimed here. The final PR checks provide the exact-head repository-wide acceptance result.

Local verification after integrating main `b0d0818`:

- `pnpm verify:static`, `pnpm test` (**4,006 tests / 347 files**) and `pnpm build` passed.
- The focused Playwright run for assistant pages, recorded results, contextual filters, Activity detail and checklist lifecycle passed **25 journeys**, with one intentional desktop-only observer case skipped on mobile.
- Earlier surrounding browser runs passed authentication recovery, global-route ownership, desktop settings and retained-workbench behavior. Final CI runs every repository browser and native-runtime gate on the committed head; partial local runs are not represented as a complete browser gate.
