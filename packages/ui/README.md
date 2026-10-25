# Pi UI

Paper-first UI primitives in a shadcn-compatible workspace package. Storybook is hosted at https://ui.cill-i-am.com.

Import components from `@workspace/ui/components/button`, utilities from `@workspace/ui/lib/utils`, and styles from `@workspace/ui/globals.css`. Components are source exports; no bundled duplicate of React or app backend is included.

The application has not been migrated to this package. The source of visual intent is Paper's **UI primitives** page, including **Cards & frames**. Native Base UI retains focus, gestures, keyboard handling and overlay lifetime; XState/Effect owns the review scenario lifecycle.

Commands from the repository root:

- `pnpm storybook`
- `pnpm build:storybook`
- `pnpm test:ui`
- `pnpm test:ui:browser`
- `pnpm deploy:ui`

Interactive stories use scoped official Effect actors and synthetic work only. Uncertain outcomes require checking the existing attempt; no production calls are made.

Coverage and limitations are documented in Storybook's examination stories and the browser/model test output. Finite modeled states and transitions are reviewable; no claim is made about every possible string, prop combination, browser or assistive technology.

## Card anatomy

One `CardFrame` recipe: continuous 14px outer rim, 3px inset, 10px panel. Headers and context/action/split footers are optional sections on that same frame. There is no alternate flush/extended frame variant. `Card` remains the plain white content surface.
