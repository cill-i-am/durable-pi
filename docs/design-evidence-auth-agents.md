# Authentication and assistant redesign evidence

Status: Paper and implementation complete for this scope. Local verification is recorded below; CI, merge, deployment and production behavior are separate.

## Source and Paper gate

Read the existing auth, invitation and assistant components before drawing. Applied Executor `executor`, `build-design`, `design-exploration-swarm-paper` (states reference), `better-layout`, `better-writing` and `better-ui`. Personal Skills revision: `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Executor had no suitable Paper tool; used the connected Paper plugin after capability search.

Design source: [Build · Sign-in & assistants](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-E-0). Approved shell and primitive conventions were read from [Conversation First](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1) and [UI primitives](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-A-1). Read the current Paper guide, confirmed Geist availability, and extracted tokens (hash `fc280747`), JSX without node IDs and computed styles. Screenshots were used to review composition, not infer CSS values.

The page-specific Paper boards preceded the relevant code edits. Desktop states are arranged in three regular columns. Mobile structural examples are 390 × 844. Every board was visually reviewed; the one-time code fields were refined into six separate slots, duplicate archived navigation was removed, and mobile controls use the shared 44px touch size. Review also aligned the desktop editor with the existing edge-anchored 24px sheet corners and kept the collection as the edit backdrop.

[Less is more](https://jakub.kr/writing/less-is-more) informed the removal of duplicate collection navigation, decorative welcome content, repeated privacy explanations and empty passkey status space. Required expiry, private-work, challenge, pending and recovery information remains.

| Board                    | Paper node |
| ------------------------ | ---------- |
| Sign in                  | `1GBA-0`   |
| 02 · Owner setup         | `1GDD-0`   |
| 03 · Password recovery   | `1GFH-0`   |
| 04 · Recovery sent       | `1GH6-0`   |
| 05 · Reset password      | `1GHR-0`   |
| 06 · Reset unavailable   | `1J1H-0`   |
| 07 · Authenticator       | `1J20-0`   |
| 08 · Recovery code       | `1J2O-0`   |
| 09 · Passkey waiting     | `1J3C-0`   |
| 10 · Invitation account  | `1J3Y-0`   |
| 11 · Invitation accept   | `1J51-0`   |
| 12 · Invitation recovery | `1J5U-0`   |
| 13 · Invitation verify   | `1J7F-0`   |
| 14 · Invitation welcome  | `1J92-0`   |
| Active assistants        | `1JR1-0`   |
| Archived assistants      | `1K1B-0`   |
| New assistant            | `1KA6-0`   |
| Edit assistant           | `1KH3-0`   |
| Archive confirmation     | `1KK9-0`   |
| Recovery states          | `1KM7-0`   |
| Mobile sign in           | `1KSN-0`   |
| Mobile editor            | `1KUH-0`   |
| Mobile assistants        | `1KXC-0`   |

## Route and state coverage

| Surface | Reachable states preserved |
| --- | --- |
| Workspace sign-in | Password sign-in, owner setup, requesting, server error, setup receipt, passkey availability/device wait/error |
| `/forgot-password` | Email form, request error/retry, non-enumerating receipt, another email, canonical return link |
| `/reset-password` | Hash-token opening, new password/confirmation, mismatch, pending, invalid/used link, completion/token removal |
| `/two-factor` | Six-digit authenticator, backup code, mode clearing, rejected code/retry, pending and return destination |
| `/join` | Loading, account creation/sign-in, passkey, wrong account, verify/resend, accept/pending, welcome, unavailable, temporary error/retry |
| `/agents`, `/agents/archived` | Active/archived lists, filter/empty/clear filter, direct editor entry, home protection, restore |
| `/agents/new`, `/agents/:slug/edit` | Create/edit sheet, live preview, draft, pending lock, acknowledged save and failed catalog refresh reconciliation |
| Archive confirmation | Named consequence, kept work, focus on Cancel, pending lock, failure and retry |

Access-ended, workspace startup, root not-found and route recovery belong to the root shell owner. Account/security preferences and family settings belong to their respective owners.

## Implementation

- Auth: `src/features/auth/{auth-frame,login,password-recovery,two-factor-challenge,passkey-sign-in,verification-code}.tsx` and `auth-entry.css`.
- Assistants: `src/features/agents/{agents,agent-collection,archive-agent-dialog}.tsx`, `index.ts` and `assistant-management.css`. Removed obsolete `AgentSidebar`; root wires the single `WorkspaceNavigation` and collection editor callback. The collection header uses the existing `SidebarTrigger` on mobile.
- Invitation: `src/features/family/join.tsx` and `family-entry.css`. Family file boundary agreed with settings owner before edits.
- Fixture parity: `scripts/performance/client.tsx` now registers the real ForgotPassword, ResetPassword, TwoFactorChallenge and agent edit feature routes, using the production validators and route options.
- Tests: `tests/browser/auth-entry-design.spec.ts` exercises setup, reset-request failure/retry, reset confirmation/token cleanup, authenticator/recovery switching and unsupported-passkey password fallback. Existing tests retain their behavioral assertions while selectors follow the intentional assistant wording.

No backend, auth machine, owner, hook, family authority or persistent domain data changed. Shared primitives and theme remain authoritative. The existing dither AgentAvatar and AgentMark render in code; the Paper initials are identity placeholders. Button textures, device hit areas and focus come from `@workspace/ui`.

## Verification

- Affected unit owners and catalog tests: **48 passed across 6 files** (`auth-ui-lifecycle`, `family-ui-lifecycle`, `agent-editor-machine`, `agent-archive-machine`, `agent-collection`, `catalog-state`).
- Source typecheck, affected-file lint, formatting and diff whitespace checks passed after fixture parity additions. The collection tests also passed after adding the existing sidebar provider to their render fixture.
- Initial browser comparison at 1440 × 900 identified old PasswordInput fixed height 50px; corrected to 40px on fine desktop pointers and 44px on touch. OTP gaps corrected to the reviewed design.
- Browser verification uses the provider-free local fixture. An initial run was invalidated by missing fixture routes and a concurrent dependency relink; those results are not a final pass.
- Final affected browser suite: **46 passed** at desktop 1440 × 900 and mobile 390 × 844. Includes all five new auth journeys, assistant draft/refresh/restore cases, invitation and family ownership/recovery cases. No real invitation, sign-in provider, approval or message was modified.
- Visual comparison: desktop sign-in controls measured exactly 400 × 40; mobile inputs render at 16px and 44px with no horizontal overflow. Actual assistant editor width is 480px. Mobile collection review led to a compact inline action row and a header sidebar trigger, recorded on a dedicated mobile Paper board before code.
- Final rebuilt-fixture smoke passed at **320px, 390px and 1440px**: no horizontal overflow; compact collection rows; mobile sidebar opens and Escape returns focus to its trigger; editor has 24px preview spacing and stays 480px on desktop; collection remains mounted while editing and no conversation is mounted; resizing preserves the Name field. Browser error log was empty. Final screenshots are `/tmp/pi-auth-signin-desktop-final.png`, `/tmp/pi-auth-signin-mobile-final.png`, `/tmp/pi-auth-agents-collection-{desktop,mobile,320}-final.png` and `/tmp/pi-auth-agents-editor-{desktop,mobile}-final.png`.
- Updated auth-entry suite rerun against the final build: **10/10 passed**, including collection edit backdrop and canonical Cancel return assertions. The earlier 46-case suite remains the complete affected journey run; root owns the final repository-wide gates.
