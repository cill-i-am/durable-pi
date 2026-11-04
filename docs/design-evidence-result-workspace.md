# Recorded results in the assistant workbench

The accepted Paper flow is inline content (C), companion workbench on explicit Open in workbench (A), and the existing expanded workbench on explicit expand (B). Source: [Conversation First · Refined workspace](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1), desktop frames `1M4Z-0`, `1M6A-0`, `1M7L-0` and phone `1MFY-0`; the Examples source is `1N43-0`. All six exploration screenshots and their structural summaries were reviewed before selection. JSX exports and computed values were read directly from Paper; existing semantic tokens, native drawer and workbench geometry remain the implementation basis.

## Source ownership

- `workbench-tabs.machine.ts` admits fixed tools, Examples and validated recorded-result instance IDs. The router alone owns active selection. Hide retains opened tabs; close removes one presentation without deleting its recorded result. Existing keyboard selection, explicit close, expanded mode and mobile tab-picker behavior remain.
- `workbench-presence.machine.ts` retains native closing acknowledgement and revision fencing. It owns the optional return-to-composer intent; an overlaid route or explicit reopening revokes it. Base UI performs focus restoration to the owning assistant's ref, with a current-route/visibility fence. There is no independent animation timer or focus runner.
- `result-workbench.tsx` uses the existing Activity query owner to recover an exact committed rich-result tool output by turn/tool/element identity. The tool must be complete, recognized by the existing rich-result contract, contain valid bounded result data, and contain the requested element. Cached and fetched values both enforce the element boundary. Failed or unavailable reads show the existing query error with read-only retry and a return action.
- `result-view-state.tsx` contains ordinary view values only: table search/sort/filter/columns/pagination, unfinished filter column/operator/value/error, product shortlist/budget/view and question input. Its lifetime is the signed-in, keyed assistant workspace. It holds no commands, receipts, actor snapshots or progression rules.
- Inline content becomes a source link while its result tab owns the full editing surface. The two presenters read the same element-scoped values; they do not mount duplicate actionable controls or maps. Per-element identity is taken from the validated JSON result tree without changing its public schema.
- Map acquisition and release remain in the existing map actor. Hiding or leaving a retained surface unmounts only its scoped map child and runs its existing joined cleanup; selected-place state stays with the parent.
- Examples is a built-in workbench tool, reached through Open a tool. The sample marker remains explicit. Add to draft and Add shortlist to draft use the existing composer draft owner and never send a message. The old composer demo CTA and demo modal are removed.

Only recorded identities enter URLs. Output, questions, filter text, shortlists and drafts remain private client values. This change adds no backend endpoint, durable table, provider operation, retry engine or dependency.

## Verification

- Scoped production and test lint passed; `git diff --check` passed.
- 227 focused tests passed across result identity/SSR retention, tabs, presence, workspace routes, rich answers, question and map ownership.
- The added native-focus actor test checks settings during closure, explicit reopening and stale native close acknowledgement. It observes actor completion rather than assuming an enqueued event is synchronous.
- `tests/browser/result-workspace.spec.ts` defines desktop/mobile journeys for recorded-result promotion, filter-draft/search/sort retention, hide/reopen, expanded mode, resize, explicit close, unsent composer retention, deep-link reload through recorded Activity, unavailable identity and absence of message sends.
- Integrated result-workspace journeys passed desktop and mobile, including deep-link recovery and unavailable-result return. The wider rich-result suite passed shortlist/draft retention, CSV search/sort/export and map cleanup.
- The built editor, People and Examples layouts were visually reviewed against their Paper references at desktop and phone widths. The delivery record is [Contextual flows](design-evidence-contextual-flows.md); runtime proof remains separate from static Paper states.
