# Stale-tab recovery and composer drafts

Accepted October 19, 2026. A deployment can retire a JavaScript chunk while an older tab is still open. Retrying navigation in that tab can request the same missing chunk again. Recovery loads the replacement application through an explicit reload and preserves the unsent composer state.

## Decisions

| Decision | Consequence |
| --- | --- |
| Add a small updates feature over the existing build revision. | A public, uncached GET `/api/version` returns only the website build ID. It reads no account, secret, database, or agent state and wakes no agent. The existing protected deployment probe retains its separate purpose. |
| Check on initial load, focus, reconnect, visible-tab changes, and a five-minute foreground interval. | An idle background tab does not poll. Requests coalesce while one is in flight and have a five-second timeout. A different valid revision offers a persistent update notice. A failed check does not establish that an update exists. |
| Require the person to choose Reload. | Detection never reloads, resends a message, or retries a tool. Repeated clicks are fenced while navigation starts. Offline state disables reload. There is no automatic reload loop. |
| Catch known import failures near lazy settings and workbench screens. | The conversation remains mounted while a failed screen offers Reload page. A confirmed different build says Pi has been updated. Otherwise, the explanation describes a failed download. Ordinary API/loader/render failures retain their existing retry/error handling. |
| Reuse existing edit/pending state as reload protection. | Open edits, pending saves, message submissions, uploads, recordings, and interactive terminal sessions must finish or be explicitly resolved before using Reload. A native before-unload warning also applies while a fence exists. Agent inference can continue on the server while the browser reloads. |
| Preserve the composer in tab-local session storage, keyed by authenticated person and stable agent ID. | Restore unsent text, selected file references, profile/job choices, and the original unconfirmed submission ID. There is no automatic submit after restoration. Successful sends clear consumed draft state. Normal manual retries reuse the existing submission identity. |
| Persist references rather than file contents or prepared media. | The existing workspace still owns bytes, processing, current ownership, and admission checks. Restored metadata cannot grant access to a file. A raw upload or recording must finish first. |
| Validate and bound draft recovery. | Use the existing send and file schemas, the 30,000-character message limit, four references, and a 500,000-character serialized bound that accommodates escaped maximum-size text and its saved attempt. A blocked/quota-limited storage write keeps the live draft and disables Reload with an explanation. |
| Clear stored drafts on confirmed sign-out or person change. | Another family member cannot inherit the previous person's composer. Late writes from the old person are fenced. Temporary session lookup errors do not independently clear drafts. |
| Use the installed Base UI stack. | Add the official toast source while retaining the existing Button. Position the update notice clear of the composer controls on desktop and mobile. Keep the error callout and actions in shared components. |

## Verification

`tests/client-recovery.test.ts` checks explicit navigation, independent fences, offline state, valid revisions, rejected navigation, and narrow asset-error classification. `tests/composer-draft.test.ts` checks identity-preserving restoration, person/agent isolation, sign-out and late-write fences, invalid data, attachment-reference projection, and escaped maximum-size drafts.

Browser journeys exercise the real UI with synthetic auth/storage/provider boundaries: a normal update, an actual failed lazy chunk, file-reference restoration, an accepted send whose acknowledgement is lost, a held upload, unavailable session storage, and a pending microphone request. Existing route-recovery tests retain their navigation-only retry behavior for ordinary failures.

`pnpm test:client-upgrade` builds two distinct real frontend bundles, retains one live fixture server/account, atomically replaces its served assets, observes an old chunk return 404, reloads through the error action, and verifies a different entry bundle, retained draft/file, and zero conversation submissions. It also confirms that evidence survives cleanup. Set `PI_BROWSER_CHANNEL=chrome` to exercise installed Google Chrome and `PI_UPGRADE_EVIDENCE_DIR` to retain artifacts outside the default ignored test-results directory.

The local Chrome two-build acceptance passed with one retired-asset 404 and zero submissions. This proves the actual frontend/build transition against the disposable fixture. Production sign-in, live model behavior, and provider delivery remain separate checks. Hosted acceptance and deployment are reported with the release.

References: [Vite load-error handling](https://vite.dev/guide/build.html#load-error-handling), [Base UI toast](https://base-ui.com/react/components/toast), and [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
