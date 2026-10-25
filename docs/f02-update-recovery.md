# F02 update and safe-reload ownership

**Release status — 25 October 2026:** the refactor is [merged, deployed and verified](xstate-effect-release.md). The checkpoints below retain their original source and test scope; pre-merge delivery status is historical.

`features/updates/recovery.machine.ts` owns version-check occupancy and explicit reload admission through the official XState/Effect integration. The component creates the owner in a scoped Effect and interrupts that scope on unmount. Conversation draft persistence and uncertain submission identities remain owned by their conversation features. An update never submits a message or retries a tool.

## State and authority

The parallel `version` region is idle or checking. Checking has waiting and expired states. Focus, connectivity, visibility and retired-asset events request checks; concurrent requests coalesce. The idle region polls after five minutes. A check requests native abort after five seconds, then keeps occupancy until its actual fetch and body work settle. A late result after expiry or owner revocation cannot publish an update. There are no automatic transport retries within a check. Offline and hidden pages do not start network checks.

The parallel `navigation` region is idle, attempting or reloaded. Only an explicit reload event may enter attempting. Independent feature guards and online status must permit admission, and the invoked navigation capability checks the current registrations again immediately before calling the browser. A synchronous browser navigation error returns to idle; successful dispatch admits no second reload. Replies await the actor decision rather than treating asynchronous mailbox delivery as completion.

Guard registrations are synchronous resource facts: a map retains each feature's reason, including unreadable or unsaved drafts. This same registry supplies `beforeunload` and the final native navigation check. It does not own reload progression. The actor projects those facts for the disabled button and message. Removing one registration never clears another feature's guard.

## Cleanup and compatibility

Unmount revokes the owner's authority immediately, removes all native listeners, interrupts the actor scope and joins the outstanding version promise. If native work ignores abort, scope closure waits for it; a replacement check is not admitted by that owner. Non-success HTTP responses cancel and join their body before the check releases occupancy. Reload callers awaiting a discarded actor receive false. Ordinary transport errors remain advisory. Native structured failures containing a defect or interruption retain every original reason through joined scope closure, including failures arriving after abort. The owner reports those failures after the invocation joins; actor interruption does not silently discard its cleanup Exit. Browser guards and update revisions are ephemeral; no machine snapshot is stored, and this migration changes no existing browser storage keys or record formats.

The existing conservative revision and asset-error rules remain: only a different 40-character hexadecimal revision offers an update, a current-revision response cannot hide a known update, and ordinary API/render failures are not classified as retired assets. Unknown or unreadable draft data remains a conversation-owned reload fence, never a reason to erase storage.

## Evidence

`tests/client-recovery.test.ts` exercises independent guards, final dispatch revalidation, one explicit reload, failed navigation recovery, malformed events, request coalescing, five-second expiry with held native cleanup, listener release and late-result fencing. `tests/update-version-request.test.ts` holds native response-body cancellation to prove that unsuccessful HTTP headers do not release occupancy early.

`tests/browser/stale-tab.spec.ts` preserves unsent text/file references, uncertain send identity, upload fences and failed-storage fences. The navigation assertion waits for an observed browser navigation. `tests/browser/update-recovery-owner.spec.ts` adds offline recovery with zero submissions. `scripts/check-client-upgrade.mjs` uses two real builds to retire a lazy asset, reload explicitly, and recover the same draft and file references without submitting.

The original implementation failed a late-fence control: a subscriber registering an unsaved draft when reload admission became visible could not prevent the subsequent browser reload. The new final-dispatch regression rejects that same navigation for both draft and offline changes. These are isolated local fixtures; they do not assert deployment or provider delivery.
