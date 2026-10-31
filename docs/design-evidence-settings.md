# Account, family and assistant settings

The existing source capabilities were inventoried before editing each surface. Paper coverage was prepared and inspected before the presentation edits. Application owners, request identities, revision fences, native drawer lifetimes, pending locks, local drafts, uncertainty and recovery were retained. No provider connection, invitation, approval or outbound message was sent during verification.

## Design sources and method

- Executor catalogue and `executor` skill read at the start. Executor had no Paper capability, so the connected Paper tools were used.
- Shared skills read from Personal Skills revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`: `design-exploration-swarm-paper`, `build-design`, `better-layout`, `better-writing`, `better-ui`.
- [Jakub Krehel, Less is more](https://jakub.kr/writing/less-is-more): remove decorative previews and repeated explanatory chrome; group related controls, retain consequential guidance and recovery.
- Paper guide and mobile status-bar guide read. Geist availability and weights checked. Existing tokens read (`fc280747`). Approved shell references `1ATY-1` and `1BS3-1`; shared primitives `18OJ-1`, `19KC-0` and the page `p-A-1` inspected.
- [Build · Account & family](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-D-0) is the settings design record. Existing detailed security/family states were copied into this page; other capability groups were authored there. The copied family desktop frames supply their interior states; the refined workspace shell and compact settings navigation supply the surrounding chrome.
- Screenshots inspected for every artboard. JSX extracted with node IDs excluded for all sixteen boards; computed styles read for the root, profile, preferences and desktop setting surfaces. Screenshots were used for visual checking, not to infer unavailable token values.

The settings implementation uses the existing shared UI controls and framed surfaces. Content is 14px, descriptions 13px/20px, group titles 16px/24px, page titles 20px/26px. Related rows use 16px padding, framed sections use 20px where appropriate, page content is limited to 760px. Phone views use 16px page insets and the shared overlay's 24px sheet radius, mounted native stack, gesture and reduced-motion behavior. Desktop workspace radius maps the 16px Paper value to the existing 14px shared radius; this is a 2px token rounding.

## Source capabilities and design coverage

All node references below are in the build page linked above. Their retained mobile state sets are full-size 390px views, not thumbnails.

| Route / surface | Existing capability and important states | Paper artboards |
| --- | --- | --- |
| `/settings` | Personal index; session identity; eight sections; channels visible only to the family admin | `1GB5-0` root/account/preferences; `1GNL-0` personal mobile set |
| `/settings/account` | Current identity/photo; JPEG/PNG/WebP file selection; automatic save; photo removal; pending, notice and real validation/server errors | `1GB5-0`; `1GNL-0` account |
| `/settings/preferences` | Light/dark/system theme; device preference; message delivery default; interaction sound preference and test action | `1GB5-0`; `1GNL-0` preferences |
| `/settings/security` | Two-factor off/on; manage/setup; passkey list/add/rename/remove; device confirmation/cancellation/unavailable browser; session refresh; one/other session revocation; sign-out confirmation; reauthentication and read errors | `1GIF-0` security desktop; `1GKQ-0` passkey states; `1GNL-0` mobile security; `1K48-0` password, recovery codes and verification |
| Two-factor child view | Current password; enable/disable/replace codes; QR and manual key; six-digit verification; recovery-code copy/download/acknowledgement; pending and errors | `1K48-0` |
| `/settings/connections` | Library and Executor defaults; add trusted HTTPS server; OAuth sign-in; reload/reconnect/refresh tools/disconnect; tool expansion; callback failure; uncertain operation retained | `1J4C-0` library/add/repair; `1GNL-0` mobile library |
| `/settings/skills` | Library/archive tabs; new/edit/archive/restore; Markdown file import; Executor provider/app catalogue and preview; version history/restore; source provenance; preserved draft and revision conflict choices | `1JDV-0` library/import/conflict; `1GNL-0` mobile library |
| `/settings/channels` | Admin-only WhatsApp setup, target choice, explicit reroute save/cancel, enable/disable, open provider; previous reply ownership; recent delivery receipts; same-request recovery and duplicate-risk confirmation | `1JO1-0` channel/delivery states; `1GNL-0` mobile channels |
| `/family` | Members and roles; admin invitation form; send receipt; delivery failure/resend/cancel; remove member confirmation; background-work and private-data consequences; read-only member view | `1IEJ-0` admin; `1IIY-0` invite; `1IOB-0` removal; `1IWD-0` member; `1J00-0` recovery; `1GNL-0` mobile family |
| `/family/model-access` | Shared ChatGPT status; admin sign-in/reconnect/refresh; pending callback return address, retained draft and discard; saved-but-unverified status; non-admin recovery message; privacy boundary | `1IT0-0`; `1J00-0`; `1GNL-0` stacked model access |
| `/agents/$agentId/settings` | Assistant identity and five-section index; correct resource scope | `1HUF-0` assistant mobile set; `1GLY-0` desktop shell |
| Assistant General | Existing name/instructions; edit entry; admin-only private email enable/disable/address/copy; recent messages, delivery outcomes and retry confirmation | `1HUF-0` General; `1JO1-0` email/delivery |
| Assistant Models | Seven job routes; model and reasoning; dirty/save/cancel; running jobs retain model; saved notice; unavailable model; unconfirmed save check and shared Model access navigation | `1GLY-0` desktop; `1HUF-0` Models |
| Assistant Connections | Automatically included Executor tools; maximum sixteen other tools; available/selected tools; add/remove; manage global library; per-call approval guidance | `1J4C-0` assignment; `1HUF-0` Connections |
| Assistant Tool access | Per-tool Allow/Ask/Deny; exact-input approval and already-running work guidance; save/refresh error; Browser and Terminal access destinations | `1K48-0`; `1HUF-0` Tool access |
| Assistant Skills | Four pinned revisions; use/remove/update to latest; archived source remains pinned; manage global library; applies to new replies without granting tool access | `1HUF-0` Skills; `1JDV-0` versioned library |

There is no signed-in Change password page in the current source. Password entry in this settings scope belongs to two-factor setup/management. Password reset remains in the sign-in owner's existing flow. No new password operation was invented.

## Implementation

- `src/app/workspace-settings.tsx` and `workspace-settings.css`: route-driven setting presentation, compact navigation, content hierarchy, preferences, general summary and responsive layout. Legacy settings/family style ownership moved out of global CSS by the foundation owner.
- `src/components/settings-section.tsx`: shared CardFrame/Card anatomy for the existing settings section abstraction.
- `src/features/appearance/appearance-settings.tsx`: shared theme controls and real preferences; removed the decorative activity preview. The root owner connected the existing saved motion preference to the shared MotionProvider; its visible label is now Interface animations.
- `src/features/auth/{account-security,passkey-settings,factor-settings,profile-photo}.tsx`: presentation and account identity; existing owners and focus/recovery logic retained. PasswordInput continues using the shared input-group controls through its existing adapter.
- `src/features/{connections/connections-panel,skills/skills-panel,skills/hosted-skill-import,access/access-panel}.tsx`: aligned groups, forms, selected rows, tool modes and meaningful source terminology. No hook/machine changes.
- `src/features/conversation/{model-defaults,delivery-settings}.tsx`: grouped model fields and compact message-delivery preference.
- `src/features/{email/email-settings,whatsapp/whatsapp-settings}.tsx`: settings group presentation. Channel routing, delivery state and resend authorization unchanged.
- Family settings/model-access markup continues using its original owners and controls; the new owning settings stylesheet supplies the designed roster, provider, privacy and invitation presentation.

## Verification

- Before code: all listed source branches inventoried; all listed Paper boards rendered and inspected; JSX/style extraction complete; boards arranged in non-overlapping named rows and working indicators released.
- Typecheck: passed after initial implementation.
- Targeted lint and formatting: passed for the edited presentation files.
- Behavioral/restoration checks: 119 tests passed across ten affected suites (`account-security`, `passkeys`, `family-ui-lifecycle`, `family-model-access-parity`, `model-defaults-lifecycle`, `settings-drawer-lifecycle`, `settings-stack`, `access-connections-ui`, `skills-ui-lifecycle`, `channel-settings-ui`).
- Provider-free fixture build: passed, using `scripts/performance/server.mjs`, independent output `dist/settings-review`, port 4422.
- Initial desktop and phone visual review found a compressed interaction-sound label at 390px; corrected by placing its action zone below the text. Shared toggle label wrapping and popup stacking findings were sent to the foundation owner for their owned primitives.
- Browser preservation: sixteen desktop cases passed, covering the four WhatsApp ownership cases, six family journeys, two model-access pending/recovery cases, two model-default fencing cases, photo replacement/removal and the actual sidebar settings-index journey. The first run was interrupted by shared dependency reinstall; those invalid worker exits are not counted as behavior results. The desktop popup selection issue was fixed by the foundation owner and its four affected channel cases passed afterward.
- Phone preservation: all twenty-two cases have passed across the complete run and isolated correction rerun. The full run passed twenty; one archived-target case completed its assertions but lost a trace file during separate concurrent artifact cleanup, and one real failure restored the native sidebar over the composer after settings dismissal. The root owner corrected the existing account-menu action to close the sidebar before dispatch. A fresh fixture build and isolated rerun then passed all three selected cases: archived WhatsApp target, both settings indexes through the actual Assistant settings menu, and full native parent retention/focus restoration/composer draft preservation. The passing full-run cases also cover swipe dismissal, cross-scope model-access history, retained native exit bodies, landscape draft fencing and browser-Back lifetime.
- Independent visual review corrected the mobile root to match the existing Paper composition: title toolbar, actionable account identity and separate personal/family groups. Embedded Account security omits the duplicate Done action while its standalone mode retains it. Product-visible settings titles use Assistant settings; domain routes and contracts retain their existing agent names.
- Final 390px root screenshot inspected after the focused rerun (`/private/tmp/settings-root-mobile-verified.png`): account avatar retains its 32px slot, the three groups fit, controls remain reachable and nested native parents stay visible as sheet layers. Final Preferences screenshot inspected at 390px (`/private/tmp/settings-preferences-mobile-final.png`), with uncompressed labels, one aligned segmented theme control and inset actions. The independent reviewer also checked 320px dark Preferences, reporting no overflow and zero axe violations.

Paper proves composition. The local fixture and behavioral checks provide separate implementation evidence. No CI, merge, deployment or production verification is claimed here.
