# Agent browser and owner takeover

Let an agent inspect and interact with websites in a private remote browser, then take control when human input is needed.

## Sub-features

- `browser-destinations`: Configure exact allowed hostnames or explicit unrestricted public-web access.
- `browser-open`: Open a page and inspect bounded text, links, and screenshots.
- `browser-interact`: Click, type, press keys, or scroll against a recent capture.
- `browser-takeover`: Pause agent browser tools while the owner uses the same session.
- `browser-return`: Return control, close the session, and recover cleanup failures.

## How to get to it (user POV)

- Open `/agents/AGENT_SLUG/browser` or choose Browser in the workbench.
- Configure browsing destinations in that panel; use **Browser URL** for owner navigation.
- Ask the agent to browse a permitted site using `browser_open`, `browser_read`, and `browser_interact`.
- Use the visible takeover/return controls on the captured remote page.

## Driving it with the verification harness

Preconditions: Browser Run is an external Cloudflare service even during local development. Use a permitted public page with no private form submission.

- **Read journey.** Permit `example.com`, open `https://example.com`, and confirm the page identity, captured text, and screenshot.
- **Takeover.** Start owner control, verify a bot browser attempt waits or refuses appropriately, then return control. Do not submit external forms during a read-only test.
- **Policy change.** Close the test session, change permitted destinations, and confirm a disallowed hostname is rejected before navigation.
- **Checks.** Run `pnpm test tests/browser.test.ts tests/browser-driver.test.ts tests/browser-boundary.test.ts tests/pi-browser-recovery.test.ts`.
- **Proof.** Preserve page identity, capture/version, requested action, and resulting capture; include cleanup state.

## Gotchas

- The view is screenshot-based, not a live video stream. Session limits are two minutes idle and ten minutes total.
- Unrestricted internet does not permit non-web schemes, embedded URL credentials, arbitrary scripts, or warning bypasses.
- Changing browser policy closes the previous session and fences stale results.
- Browser access has provider usage costs. Do not treat synthetic driver tests as authenticated-site acceptance.
