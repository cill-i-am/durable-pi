# Inline answer design evidence

## Scope and sources

The live answer gallery and the bounded inline answer catalogue in `src/features/rich-results`: Stack, Brief, Question, Weather, Calculation, Places, Route, Products, DataTable, Comparison, BarChart and Timeline. The renderer, persisted JSON contract, provider adapters, URL validation and application-owned machines remain unchanged.

Read the current source and actual examples before design. Applied Executor `build-design`, `better-ui`, `better-layout`, `better-interface`, `better-accessibility`, `better-colors`, `better-typography`, `better-writing` and `interface-review` from `personal-skills` revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. [Jakub's less-is-more guidance](https://jakub.kr/writing/less-is-more) informed the removal of decorative card icons, the repeated sample badge, product sidebar eyebrow and duplicated fallback title, and the comparison verdict badge. Meaningful limits, source freshness, draft boundaries and retailer confirmation remain visible.

Designed first in [Pi — Production UI / Build · Inline answers](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-I-0), tokens hash `fc280747`. The page uses two columns, 80px gutters and fit-content boards. Read the Paper guide and font information, extracted JSX and computed styles from every board before implementation, and reviewed screenshots. Final corrections made question validation visibly disabled, restored actual example text, corrected forecast values against `examples.ts`, and used the existing background token for white card surfaces.

| Board | Actual surface and state | Design decision and implementation |
| --- | --- | --- |
| `1KZG-0` · Answer gallery | Eleven real categories, illustrative shopping example, draft prompt action | 1152px desktop gallery; Geist; 24px desktop inset; compact sample question; secondary prompt action. One descriptive sample notice replaces a repeated badge. Categories scroll horizontally on phones. |
| `1L19-0` · Products | Filtered offers under €200, two saved products, comparison, no matches and fewer than two selected | Existing shared Card/Frame/Footer, filters, up-to-four shortlist, source and external retailer links retained. Removed decorative shopping icon and repeated sidebar title; actual context and comparison priorities remain. |
| `1L7P-0` · Questions | 390px editing, added-to-draft and failed-append states | Separate full-width options with descriptions, 64px minimum height, 12px gaps, quiet selected border and checkmark; vertical keyboard navigation. Shared ToggleGroup remains the interaction owner. Text input and draft machine are unchanged. |
| `1L7S-0` · Weather | Single dated day, weekend comparison and seven-day outlook, actual Dublin sample values | Existing detailed/overview layouts, hourly chronology, Celsius, km/h, local date handling and provenance already fit the direction. No weather layout or owner change. |
| `1LEN-0` · Places and Route | Two real coordinates, selected address, unavailable map, sourced driving estimate and directions | Existing map leases, selection, attribution, accessible fallback and teardown remain. Removed decorative header icons; functional map/directions icons remain. Estimates still explicitly exclude live traffic. |
| `1LEO-0` · Data and Comparison | Actual expenses, search/filter/columns/CSV/pagination, train/car matrix and contextual conclusion | Table controls and expansion state unchanged. Comparison now presents the verdict as a paragraph without an extra badge. Horizontal table regions remain keyboard focusable. |
| `1LEP-0` · Quantities and plans | Exact €39.525 calculation, exact expense category totals, proposed Saturday itinerary | Removed decorative calculator icon, allowed long expressions to wrap. Exact values, units and rounding explanation retained. Chart and timeline presentation already coherent and unchanged. Plans do not imply bookings. |
| `1LEQ-0` · Brief and phone gallery | Connected real example cards; 390×844 gallery with category strip and Question flow | Brief date is quiet body text; 20px title; redundant divider removed. Child sources and expandable workspace remain. The phone viewport intentionally shows scrolling content; it does not invent an alternate question flow. |
| `1LPJ-0` · Scrolled phone gallery | Question choices, input and draft action reached through scrolling | Added before the final close-control fix. Title, sample notice and native close share a sticky header, preventing the close control from covering scrolled actions. The existing body remains the single scroll owner. |

Question sources and selected checks use semantic foreground/border/muted tokens in both themes. Canonical shared depth, corners, focus and overlays supply the actual runtime anatomy. Feature CSS owns only `answer-*` selectors; no global or shared primitive rules were added. The shared responsive overlay remains the scroll/focus owner. Touch controls retain 44px targets and text fields retain 16px input text.

## Ownership and boundaries

- `explorer.tsx`, `gallery.tsx`, `rich-results.css`: gallery width, category overflow, quieter sample header and feature-scoped presentation.
- `question.tsx`: choice row markup, vertical navigation, selected checkmark and explicit added label. Existing revision-fenced append/retry actor remains unchanged.
- `cards.tsx`: source footer wrapping, expression wrapping, removal of decorative header icons and verdict badge.
- `products.tsx`, `brief.tsx`: removal of repeated presentation and quiet brief typography. Actual context, priorities, filters and shortlist remain.
- `workspace.tsx`: existing product controls join the expansion trigger in one toolbar. The trigger stays mounted for native focus restoration; filters and shortlist remain owned by their original parent. A responsive filter grid puts search, budget and retailer together when the content width allows.
- `rich-result.tsx`: imports feature CSS. Its static registry, parse boundary and error fallback are unchanged.

Source links, external directions and retailer navigation remain distinct from drafting a prompt. Selecting a question or asking about a shortlist appends an unsent draft. Gallery samples are explicitly illustrative. No purchase, booking, message send, provider call or new capability was added. The existing source/receipt fallback remains available for malformed results. No lifecycle standard exception was introduced.

## Checks

- Full TypeScript check passed after the presentation edits.
- Feature lint passed.
- 86 focused tests passed across `rich-results`, `answer-tools`, `weather`, `question` and `places-map`: bounded catalogue/privacy, exact calculations, weather dates, map ownership/restoration, question revision fencing and failure/retry.
- First combined browser run: all 14 scenarios passed on desktop 1440×900 and mobile 390×844, covering shortlist/expansion retention, unsent drafts, table search/sort/CSV, weather ranges, map replacement/held-load/unavailable restoration and syntax highlighting.
- After the final toolbar/header edits: all four affected shopping/table scenarios passed again on both viewports, including native focus restoration and the sticky title/close assertions. Used an isolated fixture on port 4498 serving the same compiled assets as the root's full-suite preview; no duplicate build or shared fixture state.
- The draft-preservation scenario now also checks blank-answer admission, vertical keyboard focus, selected option semantics, native workspace/gallery focus restoration and the visible title/close after scrolling to the draft action. Its dialog close labels follow the current shared primitive.
- Visual comparison: 1440px and 390px light theme; 320px dark theme. No horizontal page or choice overflow. Question rows measured 62px high at the current application root type scale; text fields measured 16px. The existing scroller reaches the draft action with choices retained.
- Final 320px dark scroll state: header stays at y72–176; native close and draft action each measure 44px high; the draft action remains visible at y740–784. No horizontal page or choice overflow. The title/close no longer covers the prompt or question controls.
- Axe on the final 320px dark question gallery: zero violations; one incomplete contrast rule covering shared button gradients and overlapping paint under the opaque sticky header. Visual inspection confirms the header remains opaque and text is readable. This is not claimed as a complete contrast proof.

Final captures: `/private/tmp/answers-gallery-desktop-final.png`, `/private/tmp/answers-question-mobile-final.png`, `/private/tmp/answers-question-320-footer-final.png`. Earlier captures precede the compact toolbar and sticky header correction and are not final evidence.

No commit, push, merge, deployment or production verification. Live provider lookup and retailer availability were not exercised by the fixture. All existing controls remain wired to their existing owners; sample data remains explicitly illustrative.
