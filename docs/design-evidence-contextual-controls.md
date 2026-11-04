# Contextual People and table filters

The approved Paper composition uses anchored nonmodal desktop popovers for People and Add filter, retaining the native bottom drawer on mobile. People shows the current user and assistant only. The filter keeps the table visible and presents Column, Condition, Value and one Apply filter action.

Design record: [Pi — Production UI, Contextual flows](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1), People frame `1MP3-0`, filter frame `1MXA-0`, required-value specimen `1N7Q-0`. Parent reviewed the actual Paper screenshots before implementation. JSX, computed styles and tokens were read directly from Paper before implementation. Palette token hash is `fc280747`.

## Implementation

- `src/components/ui/contextual-popover.tsx` composes Base UI Popover with the existing ResponsivePopup/native Drawer. Native primitives own collision, focus, Escape, outside dismissal, presence and nested drawers. It adds no application progression engine. Its local controlled open value projects native presentation, following existing menu/select composition.
- Desktop popovers use the approved 320px width and 14px radius, semantic surfaces and existing menu shadow. People uses 12px inset, 32px avatars, 14/22 names and subtle role badges. Filter uses 16px inset, 13/20 controls, 36px fine-pointer controls and the existing tactile Button variant.
- Mobile uses the established native drawer, safe-area padding, 18/26 title, 20px content inset, 44px controls and 16px input text. People rows become 68px tall with the existing 16/24 mobile name role.
- `ResponsivePopup.Content` gains optional class names for its existing shell and title. Existing consumers retain their previous defaults.
- Table filter column, operator, value and error use the retained result-view store supplied by the result-workbench owner. A responsive presentation can remount its native subtree; one TableControls owner retains all draft values above that branch, with only one active form and input ID set.
- The active result-surface projection gates filter visibility and submission. Numeric values stay in original units; currency alone adds a currency suffix, and percentages alone explain fractions. Filter chips and CSV logic remain unchanged. Empty numeric comparisons no longer coerce an empty string to zero.
- Apply remains available for blank submissions, as explicitly requested after Paper approval. Invalid input produces a field-local alert, invalid semantics and focus on Value. This replaces the previous disabled blank action and silent invalid return.

## Focused evidence

`pnpm exec vitest run tests/chat-header.test.tsx tests/answer-tools.test.tsx tests/rich-results.test.tsx tests/table-filter-controls.test.ts` passes **55 tests**. The new cases distinguish missing input, native numeric bad input and nonfinite values; retain zero, negatives and fractional units; and reject empty numeric comparisons rather than treating them as zero.

Scoped Oxlint and Oxfmt checks pass. No dependencies, configuration, registry, presets, tokens or deployment state changed.

## Integrated verification

The integrated browser run passed the People and filter journeys on desktop and mobile. `tests/browser/conversation-design.spec.ts` now checks desktop anchoring, nonmodal presentation and Escape focus return, plus native mobile dismissal. `tests/browser/contextual-filters.spec.ts` covers visible validation/focus, nested Column and Condition selection, dismissal/reopening, viewport changes, unique Value IDs, numeric filter application and chip removal. These checks passed in Chromium at 1280×900 and 390×844, including responsive transitions. The passing result-workbench journeys additionally verify hide, tab close and expansion retention against the real client.
