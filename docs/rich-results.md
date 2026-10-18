# Interactive answers

Pi can show interactive cards inline with its replies. Open **Explore answers** above the composer to try eleven examples and add a question to your draft. The gallery uses explicitly labelled sample data. Choosing a prompt does not send it.

## Tools and cards

| Tool | What it does | Data source |
| --- | --- | --- |
| `lookup_places` | Finds up to five address, postcode, city or landmark candidates; shows a selectable multi-pin map and directions link | Photon / OpenStreetMap |
| `lookup_weather` | Retrieves forecasts for exact local dates or today/tomorrow/weekend; adapts to one, two or more days | Open-Meteo, Celsius and km/h |
| `calculate` | Evaluates arithmetic, parentheses, powers and postfix percentages | Local arithmetic parser; no code evaluation |
| `convert_units` | Converts length, mass, volume and temperature | Local conversion factors |
| `show_ui` | Presents product shortlists, comparison matrices, tables, bar charts, timelines, maps, weather or calculations | User-supplied data or research from the existing browser/connected tools |

The library includes ten card types (Weather, Calculation, Places, Route, Products, DataTable, Comparison, BarChart, Timeline and Question), plus Stack and Brief composition layouts.

| Additional tool | What it does | Data source |
| --- | --- | --- |
| `search_products` | Opens Google Shopping candidates in the bot's existing browser; retailer verification follows with `browser_open` | Google Shopping, governed by the saved browser hostname policy |
| `compare_products` | Presents researched offers, priorities, a shortlist and an expanded decision workspace | Supplied or browser-verified product facts |
| `analyze_data` | Groups supplied rows using sum, average or count; returns the original table, summary table and a nonnegative bar chart | Deterministic local aggregation, at most 200 rows and 20 groups |
| `lookup_route` | Retrieves a driving route through two to eight sourced stops; shows distance, estimated duration, multiple pins and a route overlay | OSRM / OpenStreetMap, without live traffic |
| `show_brief` | Combines two to eight related cards in an editorial brief, preserving each card's source | Previously researched or supplied data |
| `ask_question` | Shows two to seven choices and a free-text answer; adds the response to the current draft | User choices, reviewed before sending |

Shopping supports name/merchant search, a maximum price, price sorting, a temporary shortlist of up to four products, side-by-side specifications, images when supplied, and retailer links. Each shopping result uses one currency. Unknown prices remain unknown. The renderer does not search retailer inventories, check out or place orders. `search_products` opens a search page through the existing browser service; snippets are leads, not verified offers. The agent must open retailer pages before presenting prices, availability or delivery. Restricted browsers must allow the search and retailer hostnames. Sign-in, consent and browser challenges use the existing browser controls.

Tables support numeric and multi-column sorting (Shift-click headings), search across columns, categorical multi-select facets, numeric/text conditions, column visibility, adjustable paging, reset controls and CSV export. Exports include visible columns and all filtered rows in sort order. Filters combine across columns, with OR between selected values in a facet. Columns can format currency, percentages, dates, badges and HTTPS links. CSV retains the original values and neutralizes strings that could become spreadsheet formulas. The inline limit is 200 rows, subject to the result-size limit below.

Weather cards adapt to their supplied dates: one day has a detailed outlook and an initially open hourly forecast; two days form a comparison with expandable hourly forecasts; longer ranges use a compact dated overview. The Weather gallery demonstrates 1, 2 and 7 days. `lookup_weather` accepts `period: "today" | "tomorrow" | "weekend"`, or `startDate` plus `days` (1–16); its default is seven days. Relative periods use the location's timezone. Weekend means the upcoming Saturday and Sunday, including the current day on Saturday; on Sunday it means the following weekend. Requests outside the provider's 16-day horizon fail rather than filling missing dates.

One- and two-day lookups request hourly temperatures, precipitation probabilities and wind, with daily rain totals, maximum wind/gusts, feels-like temperatures, UV and sunrise/sunset when available. Missing optional measurements stay absent. Current conditions are a separate observation and are omitted when they fall outside the requested dates. Hourly timestamps use UTC instants and are displayed in the location's IANA timezone, including distinct clock labels when daylight saving time ends. Current-day hourly views omit elapsed hours. Old saved weather results remain readable. The agent is instructed to request the relevant dates and give a short interpretation instead of repeating the weather metrics in a Markdown table. Date selection, tool schemas, rendering and interactions have deterministic tests and browser regressions. Real-model tool-choice evaluation is still separate.

Weather, maps, shopping, tables, comparisons, charts and timelines show source/date footers. They are saved snapshots. For private or user-supplied data, the source can be a label with `url: null`; no public link is required. Filters, selected map pins and shopping shortlists are local view state and reset when the card unmounts. Product and table controls preserve their state when opening and closing a workspace. Briefs display inline and expand into a two-column desktop layout or a single column on mobile. Each brief retains individual source footers. A brief is an answer snapshot, not a scheduled job. Clarification choices, shortlist follow-ups and recovery prompts append to the current draft; they never submit a message.

## Questions to try

| A person might ask | Useful presentation | Required evidence or capability |
| --- | --- | --- |
| “Which day is best for a family walk?” | Forecast and a short recommendation | Place resolution and current forecast |
| “Where is this address?” | Address candidates, embedded map and directions | Place lookup; clarify ambiguous matches |
| “What is 15% off, split four ways?” | Calculation with expression | Local calculation |
| “How many grams is 6 oz?” | Unit conversion | Local conversion; ounces mean mass |
| “Find headphones under €250.” | Shoppable shortlist and selected comparison | Existing browser or commerce connection for current offers |
| “Which pack is better value?” | Products plus per-unit calculations | Verified pack size and price |
| “Compare these three appliance quotes.” | Decision matrix | Uploaded/supplied quote facts, including installation and delivery |
| “Make sense of my expenses.” | Searchable table, category chart and CSV | User-supplied expenses; do not invent transactions |
| “Where is our energy spending going?” | Bar chart and underlying table | Bills or measured data |
| “Train or car for this trip?” | Comparison of cost, timing and flexibility | Current route, fares, parking and group size |
| “Plan a relaxed day in Dublin.” | Proposed timeline and maps | Check opening hours with the existing browser |
| “Which hotel suits the family?” | Product-style options or a comparison table | Live hotel research, dates, occupancy and cancellation terms |
| “Compare these subscription plans.” | Comparison matrix and annual-cost calculation | Current plan terms, including taxes and renewal pricing |
| “Turn these contacts into a useful directory.” | Filterable table with links | Supplied or authorized connected data |
| “Compare recipe quantities for six people.” | Scaled table and calculations | Original quantities; no guessed density conversions |
| “What happened and what comes next?” | Timeline | Sourced events; distinguish proposals from confirmed events |

These are compositions of the implemented cards. A card does not grant access to a service: flights, shops, bookings, accounts and opening hours still require the existing browser or an appropriate connected tool.

## Registry research

Reviewed 17 October 2026. These are the strongest fits found for this app, based on documented capabilities and registry source inspection; they are not all installed.

| Candidate | Best use here | Decision |
| --- | --- | --- |
| [json-render](https://json-render.dev/docs/quick-start) | Typed component catalogs and native React rendering from constrained JSON | Integrated `@json-render/core` and `@json-render/react` with our own shadcn registry. The package also offers a shadcn catalog, but local components preserve this app’s Base UI APIs and tokens. |
| [assistant-ui Elements](https://www.assistant-ui.com/elements) | Tool results, comparisons, spec sheets, maps and structured answers | Inspected `@assistant-ui/elements-data-table` and `@assistant-ui/elements-comparison-card`. Strong reference for result hierarchy and narrow layouts. Retained the existing conversation runtime and primitives. |
| [AI Elements](https://elements.ai-sdk.dev/components/tool) | Tool lifecycle, inputs, outputs, errors and disclosures | Searched `@ai-elements` and inspected its tool item. Existing Trace already provides the right integration point. |
| [mapcn](https://www.mapcn.dev/docs) | MapLibre maps with markers, popups, routes and clusters | Implemented the multi-pin and route-overlay patterns with a focused, lazy-loaded MapLibre view, self-hosted map worker, light/dark CARTO basemaps, keyboard controls and a provider-link fallback. The full mapcn registry component is not installed. |
| [Dice UI data table](https://diceui.com/docs/components/base/data-table) | Advanced filter/sort menus and denser data workspaces, with Base UI support | Implemented categorical facets, condition filters, column visibility, multi-column sorting and expanded table workspaces using the installed TanStack Table and Base UI primitives. Filter state stays local rather than entering the URL. The full Dice table framework is not installed. |
| [Prompt Kit](https://github.com/ibelick/prompt-kit) | Focused, customizable AI interface building blocks distributed through shadcn | Implemented the clarification pattern with local ToggleGroup, Field and Textarea components. Choices append to the existing composer draft. The existing conversation runtime remains in place. |

Registry searches covered `@shadcn`, `@assistant-ui` and `@ai-elements`. No theme preset or existing primitive was overwritten.

## Implementation and boundaries

- `src/rich-results/catalog.ts` owns component props, validation and the versioned result envelope.
- `src/rich-results/adapters/tools.ts` derives the agent’s JSON schemas from those same definitions.
- `src/rich-results/adapters/lookups.ts` performs fixed-host provider requests with cancellation, a 12-second timeout and a 256 KB response cap.
- `src/features/rich-results/` maps catalog components to local shadcn components and contains the gallery.
- Completed rich tools appear in the existing conversation activity timeline. The ordinary durable tool result stores the JSON; no additional database or generation endpoint is needed.
- All eleven tools appear in the existing access settings and honor the existing tool policies. Their initial policy allows these read/presentation operations.
- The renderer and sample gallery load on demand. Ordinary chat routing only imports the small tool-name contract.

The accepted format is a static json-render tree: at most 24 elements, four levels, and 28,000 serialized characters. Only `Stack` and `Brief` accept children. Brief children must be two to eight answer cards, without nested layout containers. Unknown components/props, cycles, shared children, unreachable nodes, actions, bindings, scripts and arbitrary HTML are rejected. Links and product images require HTTPS URLs without credentials. Maps use validated coordinates and fixed basemap hosts. Routes require sourced stop coordinates and provider-returned geometry. The map worker is bundled locally, rather than loaded from a script CDN. If WebGL or map data is unavailable, addresses, directions and OpenStreetMap links remain available. Invalid historical results show a recoverable message and retain the original output in the activity disclosure.

External data remains untrusted reference material. A rendered link or selected product cannot authorize a purchase, booking or other external action. Those actions must continue through their existing authenticated execution and approval paths.

Photon’s public endpoint is a [fair-use demo service](https://github.com/komoot/photon), and Open-Meteo’s public endpoint has [usage and commercial-use terms](https://open-meteo.com/en/docs). These defaults suit low-volume personal use; use an appropriate hosted/self-hosted geocoder and weather subscription before expanding service usage. Address queries go to Photon, weather coordinates go to Open-Meteo, and driving-route stops go to OSRM. The [OSRM public service](https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy) is a demo service; use an appropriate hosted or self-hosted routing provider before expanding usage. Map styles and tiles load from CARTO and OpenStreetMap. The visible map area determines tile requests. The provider defaults are fixed in the adapters; no credentials are needed for the personal-use examples.

## Validation

The feature has catalog, arithmetic, conversion, grouping/aggregation, route-adapter, rendering, malformed-result and CSV tests. Native Pi harness coverage verifies that product search retains the actor context and SDK cancellation signal, and that restricted host policies reject disallowed searches before navigation. Browser checks cover shortlisting/comparison, price filtering, table sorting/search/paging, prompt selection, map selection, mobile layout and keyboard dismissal. Live provider probes verify the lookup adapters separately from model generation. A live authenticated model-to-card conversation and deployment remain separate acceptance steps.

## Paper design coverage

The editable source is [Interactive answers · Cards & tools](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-4-0).

| Paper boards | Implementation |
| --- | --- |
| 01–08: eight original card types | The typed catalog and local shadcn registry; gallery examples and inline conversation results |
| 09: json-render, assistant-ui and AI Elements studies | Typed rendering, comparison hierarchy and the existing durable tool activity disclosures; one conversation runtime |
| 10: mapcn, Dice UI and Prompt Kit studies | Multi-pin maps/routes, faceted tables and clarification cards |
| 11: inline conversation | Completed presentation tools render alongside prose, with original output retained in activity |
| 12: decision workspace | Expanded product layout, priorities rail, shared shortlist/filter state, comparison matrix and draft follow-up |
| 13: day brief | `Brief`/`show_brief` composition with responsive inline and workspace layouts |
| 14: interaction states | Lazy loading, malformed-result recovery, empty shortlists, unknown prices, four-selection limit and zero-row filters |

Registry studies inform these patterns. They do not require installing six competing UI or conversation runtimes. Sample gallery data is labelled; the route example is a dated OSRM response.
