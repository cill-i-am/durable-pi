# Conversation design evidence

## Scope and source

Conversation at `/agents/$agentSlug`: private participant header and sheet, empty/history presentation, message labels, existing rich results and file attachments, composer, queued/steered/stopped turns, and recovery. Shell navigation and workbench interior belong to their respective owners.

Executor catalogue and `executor` skill read at start. Applied `build-design`, `better-layout`, and `better-ui` from `personal-skills` revision `70d1c37ec652e2b2a9263be9f5899d40d22ef758e3f3156ded50f95227fa2608`. Read [Jakub's less-is-more guidance](https://jakub.kr/writing/less-is-more): removed introductory copy, generic starters, duplicate settings/tool menu, decorative activity frame and orb. Kept functional model, attachment, voice, answer gallery, stop/delivery, and recovery controls.

Paper file [Pi — Production UI](https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-C-1), tokens hash `fc280747`. Read current Paper guide, JSX without node IDs, computed styles and tokens before implementation; screenshots used for comparison. Extracted and visually inspected main `1ATY-1`, mobile `1BS3-1`, participants `1CPI-1` / `1CVT-1`, workbench `1AYW-1`, dock `1DHK-1`.

Added and reviewed `1GAA-0`, “Build · Conversation · Empty, draft and recovery”, at x1888/y11112 on the same page before editing conversation code. This supplements the approved shell with an empty prompt, saved draft/working presentation, and stopped/model-disconnected recovery in context. Read its JSX and computed styles; corrected first-pass font fallback to Geist.

## Mapping

| Element | Paper | Implementation |
| --- | --- | --- |
| Header | 64px; 24px inset; 16px medium title | Same values through semantic type and radius tokens |
| Transcript/composer alignment | 720px inner content; 32px desktop inset | 784px outer maximum with 32px inset, 720px inner |
| Message type | 16px/24px desktop; user bubble 14px radius | Shared Message/Bubble, 16px/24px semantic type; radius-lg |
| User bubble | 548px maximum; padding 16px/20px | Same maximum and inset, 12px compact inset |
| Assistant identity | 24px stable avatar, 14px medium name | Shared AgentAvatar, visible MessageHeader |
| Participant stack | 32px avatars, fixed slot, overlap; 150ms ease-out fan | Actual user and assistant in fixed 80px slot, reduced motion stays static |
| Participant detail | 32px avatars, 60px rows, You/Assistant labels | Shared responsive Dialog; actual two participants and subtle badges |
| Empty conversation | One 20px prompt | Same prompt with existing Empty primitive |
| Activity | Quiet contextual status | Existing activity trace/receipts; plain working text |
| Composer | 14px radius, quiet depth; 16px input and 44px touch targets | Existing InputGroup; shared semantic radius/shadow; touch sizing retained |
| Decisions | Dock above composer; terminal receipts in history | DecisionDock mounted unconditionally, pending ApprovalCards suppressed; terminal cards retained |

The backend's conversations remain private per assistant. Paper's illustrative extra family participant, invitation action and calendar data are omitted. No family membership is interpreted as conversation access. User name/image are supplied by authenticated shell props; missing photos use initials, assistant identity uses its stable ID.

The existing model/file/voice controls need an additional composer control row beyond the illustrative 60px composer. The answer gallery remains available through its existing control. These preserve working capabilities without inventing backend actions. Existing loading, upload-error, unreadable-draft and detailed control-uncertainty branches retain their established functional presentation.

## Implementation and ownership

- `src/features/conversation/conversation.tsx`: presentation replacement, dock integration, pending-card filtering; existing MessageScroller and all command/draft logic retained.
- `src/features/conversation/chat-header.tsx`: participant stack, name tooltips and shared responsive participant sheet.
- `src/features/conversation/conversation.css`: complete conversation-owned presentation, imported by the feature; old matching global rules removed by the foundations owner.
- `src/features/conversation/turn-reply.tsx`: visible assistant identity and plain working status; activity, rich results, file outputs and recovery unchanged.
- `tests/chat-header.test.tsx`, `tests/browser/conversation-design.spec.ts`: private participant semantics, keyboard/sheet behavior and touch sizing.

No lifecycle machines or command/connection/draft owners changed. `useConversation` already retains its last complete ChatState across a same-agent reload gap; the dock remains mounted with that access snapshot during a Check status refresh. Explicit access denial still clears the projection.

## Verification

- Focused unit tests: 45 passed across header, turn reply, recovery controls, commands, draft machine, submission machine and connection composition.
- Focused lint: changed conversation components and new tests passed.
- Provider-free fixture build passed; no real message/provider mutation was used for smoke verification.
- Existing browser behavior: 20 passed across desktop 1440×900 and mobile 390×844: participant opening/focus return, draft restoration and blocked persistence, acknowledgement fencing, Stop, queueing, recovery, access denial and rolling recent-history scrolling.
- Browser visual comparison: desktop and 390px phone captures inspected. Found and corrected shared button icon sizing shrinking the participant avatar; aligned sheet close control to the title row.
- Final participant checks: 2/2 passed after the last feature CSS change, including real Tab focus name tooltip, static reduced-motion avatar positions, sheet focus return and mobile touch sizing. The shared Tooltip now supplies its tooltip role.
- Current combined preview rebuilt successfully after shell/family/assistant styles landed. Full typecheck was attempted repeatedly; the last observed failure was the other owner's stale AgentSidebar export in `src/features/agents/index.ts`, which was then removed. Full repository gates remain the root task's responsibility.
- At 320px, the actual conversation header, prompt and composer remain visible with no horizontal clipping. Current mobile header keeps its two actual participant avatars alongside the title; the illustrative three-person Paper stack sits beneath it.
- Comparison captures: `/private/tmp/conversation-history-desktop.png`, `/private/tmp/conversation-mobile.png`, `/private/tmp/conversation-320.png`, `/private/tmp/conversation-people-desktop.png`, `/private/tmp/conversation-people-mobile.png`. Earlier empty/people captures precede the final shell cleanup; the history desktop and 320px captures include the new shell.

Locally designed and implemented; no commit, push, merge, deployment or production verification.
