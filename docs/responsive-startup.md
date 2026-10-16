# Responsive startup layout

The unified loading view now reserves the workspace layout at its actual CSS breakpoints. Mobile includes the 65 px chat header, 120 px empty composer and 55 px bottom navigation. Desktop includes the 48 px top bar, 224 px sidebar, 68 px chat header and 112 px empty composer. Direct workbench links reserve the desktop panel or mobile drawer; the root route reserves its default Apps panel from 1024 px.

`WorkspaceStartup` reuses the workspace, chat, composer, navigation and workbench layout classes and existing Skeleton/InputGroup primitives. Shared sidebar, composer and drawer dimensions keep the placeholder and real UI together. CSS chooses the layout before hydration. The existing route hook supplies only public route information; the loader contains no account content or focus targets and exposes one loading status. Reduced motion stops all skeleton animations.

The desktop panel's initial `@starting-style` width animation previously compressed the newly revealed chat. Removing that initial animation preserves its reserved space. The native Sheet root now mounts open once its portal host exists, using Base UI's initial-open behavior to avoid replaying the mobile drawer entrance after the placeholder. Subsequent close, focus restoration and draft preservation still use the existing Sheet behavior.

## Measured result

| Scenario | Before | After |
| --- | --- | --- |
| Mobile chat composer vertical movement | 65 px | 0 px |
| Desktop chat header movement at 1440 px | 224 px across, 48 px down | 0 px |
| Desktop workbench CLS at 768 / 1024 / 1440 px | 0.1301 / 0.1836 / 0.2324 | 0 / 0 / 0 |
| Missing reserved chrome at startup | Sidebar, bar, navigation or panel, depending on route and width | None in the matrix |

All 15 candidate scenarios produced CLS 0 and identical header, composer, navigation, sidebar, bar and panel rectangles across session, catalog, history, metadata and ready stages. Native panel rectangles also stayed fixed on every sampled animation frame. Each run retained twenty responses, an enabled composer and no horizontal overflow. The full numeric comparison is in [responsive-startup-measurements.json](responsive-startup-measurements.json).

CLS alone missed the original mobile jump because the loading subtree was replaced. The regression collector therefore checks both CLS session windows and region geometry. It fails on CLS above 0.01, geometry drift above 1 CSS px, missing chrome, moving panel entrances, overflow, missing responses, focusable loading controls, or animation in the reduced-motion case.

## Reproduce and limits

Build the styled, synthetic fixture with `node scripts/performance/server.mjs --build-only`, then serve it with `PERF_CASE=metadata-slow PERF_SCENARIO=activity node scripts/performance/server.mjs 4423 --serve-only`. Connect an isolated Chrome session and run:

```sh
node scripts/performance/measure-layout.mjs \
  <browser-websocket> http://127.0.0.1:4423 \
  /tmp/startup-layout.json /tmp/startup-screenshots --assert-stable
```

The collector holds session, catalog and history requests separately and releases each after capturing its preceding stage. Metadata is delayed 2200 ms. It disables cache, applies 4x CPU slowdown, waits for fonts and settles for 1000 ms after readiness. It tests chat and explicit workbench links at 320, 390, 767, 768, 1024 and 1440 px, the desktop root redirect, 640×450 DPR2 reflow, and dark mode with reduced motion. The reflow case approximates 200% zoom at 1280×900; it does not set literal browser zoom.

The control UI was archived from `75f1dcbb7e7a38d6d5d4dd5236dfddda8b579a7e`. Both versions received the same fixture route corrections: register `/` and allow the fixture output directory's index file. A failed root request before the latter correction is excluded; twelve valid non-root cases were retained and the final three cases resumed after the correction. `PERF_DIST` can select an archived fixture build; `PERF_CASE=session-slow` holds the public loader for screenshot capture.

These are one accepted run per local Chrome scenario, using synthetic read-only data and the real styled CSR workspace. They prove the tested chat layout transitions; they are not production field percentiles, startup speed measurements, or proof for Safari, physical-device safe areas, the keyboard, signed-out transitions or arbitrary conversation content. Loaded history is intentionally represented by generic message shapes rather than guessed text geometry.

## Architecture review

The change stays in the view and its browser measurement adapter. It follows the Effect/reference-architecture separation by reusing the existing route capability and native UI lifecycle instead of introducing another service, runtime, data fetch or readiness gate. Existing authenticated admission, parallel data loading, persisted authority and Pi journal ownership remain with their current modules. Alchemy resources and deployment composition are unchanged. The useful shared seam here is layout geometry; the regression checks its behavior across the existing startup stages rather than adding a wrapper around each stage.
