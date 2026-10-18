# Rich answer evaluations

These cases exercise the production agent through the website: its real system prompt, full competing tool set, live providers, persistence and renderer. They use ordinary questions without tool names or grading hints. Each trial gets a fresh agent with the default purpose and model profile.

## Run against the site

Sign in normally in a dedicated eval browser once:

```sh
pnpm eval:rich-answers:live --headed --login
pnpm eval:rich-answers:live --headed
pnpm eval:rich-answers:live --case weather-weekend --repeats 3
```

The runner defaults to `https://bot.cill-i-am.com`; `--base` can target another deployment. Install Playwright Chromium with `pnpm exec playwright install chromium` if needed. Login setup sends no model requests. Each eval trial does consume the site's normal model/provider quota. Each fresh agent uses the deployment’s default model profile; the report records the model actually shown.

The runner creates only named eval agents, sends each prompt once, waits for completion, saves a screenshot and exports the agent's original-message archive through **Memory → Export & import → Archive JSONL**. It grades that export with the production archive parser and card schemas, then recoverably archives completed test agents. Interrupted agents remain available for inspection. It can reload a failed workspace twice to recover saved history after a deployment; it never resends the prompt. Export/navigation failures remain errors rather than passes. Use headed mode to review any normal tool approvals; the runner does not change tool permissions or automatically grant approval. A pending approval can time out and retain the agent for inspection.

Reports, exports, screenshots and the dedicated browser profile live under ignored `results/`. The profile holds the site's login; keep the directory private and do not commit or upload it. The harness does not read the project's `.env`, copy browser credentials into reports, or need a separate model API key.

## Grade a run made in an existing browser

The same cases can be run in the signed-in site using its normal controls. Create a fresh agent for each case, send the exact prompt from `cases.ts`, inspect completion and export its Archive JSONL. Grade it with:

```sh
pnpm eval:rich-answers:score --case weather-weekend \
  --archive /private/path/weather-weekend.jsonl \
  --ui /private/path/weather-weekend.ui.json \
  --output /private/path/weather-weekend.result.json
```

UI evidence is a JSON object with `failed` and `fallback` booleans, optional `layout` (`day`, `comparison`, `overview`), `model`, `entryScript`, `failedTools` and `staleClientReloads`. Capture these from the completed page; do not invent evidence. Omitting `--ui` explicitly produces an **archive-only** result and skips UI checks.

## Coverage and scoring

The 18 cases cover:

- Weather today, tomorrow, this coming weekend and seven days: correct lookup and arguments, Dublin location, exact local dates, 1/2/7-day renderer selection, no unrelated current observation and no repeated Markdown table.
- Calculation, oven conversion, address/map, driving route, supplied product comparison, data tables/charts, decision matrix, composed day brief and selectable clarification.
- Ambiguous Springfield, a conceptual weather question, a thank-you and an impossible year-ahead forecast: clarify or avoid unnecessary weather/UI tools.
- Live shopping research: discover offers, open each retailer before a product comparison, and return at least two priced EUR offers under €250 with battery specifications. An explicit research limitation is honest behavior, but it does not pass this functionality case.

Checks separately score required tools, argument schemas, card schemas, supported numeric facts and visible renderer/turn failures. Calculation cases now require a server computation marker and independently recompute the expression, including conversions. Embedded arithmetic in a brief is computed by show_brief itself, so it no longer requires an extra calculate call that would duplicate the card. Legacy saved cards remain renderable; an unverified model-supplied number cannot satisfy the new computation check. The original request must appear exactly once in a complete export; earlier/later answers and memory summaries cannot satisfy it. The shopping grader requires successful browser observations of each exact product URL before its card is presented, including pages reached by clicking or reading. An attempted open without a successful observation is insufficient. It also checks that price and battery numbers appear in that product page’s earlier observations. This is a bounded evidence check, not a full semantic fact-check: inspect the product identity, ANC context, availability and price qualifiers manually. General prose quality, every product fact, map accuracy and every UI interaction are not fully scored here. Existing rich-result/provider/browser tests cover deterministic implementation behavior.

This follows the distinction between tool selection, argument precision and trace outcomes in [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices) and [trace grading guidance](https://developers.openai.com/api/docs/guides/trace-grading). A single pass is a smoke baseline, not a reliability estimate. Use repeated trials when comparing prompt/model/tool changes, preserve failures and compare the same cases. The report includes a dataset hash so edited cases are identifiable.

## CI and baseline

`tests/rich-answer-evals.test.ts` runs with the normal unit suite. Its synthetic trace mutations test the graders: wrong dates/arguments, missing tools, malformed cards, incorrect arithmetic, duplicate tables, borrowed answers, incomplete exports and UI failures. **These tests are not model evaluations.** Live runs are opt-in because they require an authenticated browser and consume production quota.

`baseline-2026-10-18.json` records the sanitized outcome of the first live-site run through the existing signed-in Chrome session. Its hashes identify the case and grader revisions used for that run. Private archives and UI captures remain in ignored local results. The reusable Playwright runner is a separate execution path; this baseline was driven through normal browser controls, not the CLI runner.

The first baseline attempted all 18 cases: **15 passed, two failed and one was blocked**. The brief skipped the calculator despite a correct number; routing received HTTP 403; shopping stopped on an unconfirmed browser action after manual approvals and a view refresh during review. These outcomes are retained, not converted into passes. All four weather cases passed. See the baseline notes for provider and operator effects before using these numbers in a model comparison.

`baseline-2026-10-18-fixed.json` records the deployed rerun at `74811c0`: **18 of 18 passed, across 169 checks**, with one fresh-agent trial per unchanged prompt. Calculation grading now verifies server computation, and shopping requires two observed offers rather than accepting a research limitation. The result includes the changed grader hashes, manual retailer approvals, UI checks and operator interruptions. It is a smoke result, not a measured reliability rate or a comprehensive visual-quality score. In particular, the shopping answer still repeated its product card in a Markdown table; that duplication is recorded in the notes but is not currently a shopping failure criterion.
