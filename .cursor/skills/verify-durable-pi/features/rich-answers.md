# Interactive answers and decision views

Explore sourced tables, maps, forecasts, comparisons, calculations, and questions within an answer, then expand them without sending an action accidentally.

## Sub-features

- `answers-gallery`: Explore eleven labeled sample examples and add a prompt to the draft.
- `answers-lookups`: Look up places, weather for exact dates, driving routes, arithmetic, and unit conversions.
- `answers-shopping`: Research product candidates, shortlist up to four, and compare supported facts.
- `answers-tables`: Search, filter, sort, page, choose columns, and export the filtered/sorted CSV.
- `answers-brief`: Combine related cards in a sourced brief with expanded workspaces.
- `answers-question`: Select choices or free text and append the answer to the unsent composer draft.

## How to get to it (user POV)

- In chat, select **Explore answers** to open **Answers you can explore**.
- Ask a relevant question normally; presentation/lookup tools can produce saved cards in the answer.
- Use **Open workspace** on a supported card, **Compare (N)** on products, **Export CSV** on tables, or **Add answer to draft** on a Question.

## Driving it with the verification harness

Preconditions: Gallery examples use sample data; a model/provider journey needs actual tool use and its own evidence.

- **Gallery and controls.** Run `pnpm test:browser tests/browser/rich-results.spec.ts`. A shortlist survives expansion, table filters/sorts govern CSV bytes, and question choices append without sending.
- **Weather.** In the gallery, choose Weather and compare **1 day**, **2 days**, and **7 days**. Dates, hourly views, and absent current conditions must match the supplied example.
- **Real behavior.** Ask for a bounded calculation or exact-date weather answer without naming a tool. Inspect the actual selected tool, sourced result, date, and saved card after reload.
- **Checks.** Run `pnpm test tests/rich-results.test.tsx`; model tool-selection evaluation is a separate layer under `evals/rich-answers`.
- **Proof.** Capture both the action/tool trace and rendered result. Compare exported CSV with visible columns and all filtered rows, including rows outside the current page.

## Gotchas

- Cards are saved snapshots, not live inventories, traffic, or automatic refresh subscriptions.
- Gallery samples do not prove model tool selection or live provider accuracy.
- A shortlist, map pin, question choice, or link does not approve a purchase or other external action.
- Interactive web cards do not have equivalent email/WhatsApp rendering. Text and file delivery exist; full interactive parity remains a product goal.
- Shopping snippets require retailer verification. Unknown price/availability remains unknown.
