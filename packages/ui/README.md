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

Each primitive family has its own `Components/<name>` sidebar entry, actual component metadata, props controls and state stories. Combined flows live under `Compositions`; lifecycle scenarios remain under `Examination`.

Coverage and limitations are documented in Storybook's examination stories and the browser/model test output. Finite modeled states and transitions are reviewable; no claim is made about every possible string, prop combination, browser or assistive technology.

## Card anatomy

One `CardFrame` recipe: continuous 14px outer rim, 3px inset, 10px panel. Headers and context/action/split footers are optional sections on that same frame. There is no alternate flush/extended frame variant. `Card` remains the plain white content surface.

## Sizing and themes

Sizing uses Tailwind's spacing scale inside each component and existing shadcn size variants. There is no density provider or parallel sizing API. Default controls are 36px on fine-pointer desktops; small buttons and desktop menu items are 32px. Phones, coarse pointers and hybrid touch devices retain targets of at least 44px. Text fields retain 16px editable text on those devices. Minimum heights allow wrapping and enlarged text to grow.

Theme colours use shadcn's semantic surface/foreground pairs. Override those CSS variables and `--radius` in `src/styles/globals.css`; the existing radius aliases derive from that single value. Fonts are Tailwind theme variables. Pi's additional material variables (canvas, frame, warning, destructive fill, gradients and shadows) remain in that same stylesheet, so texture and depth can be adjusted with the theme. Components keep ordinary `className`, composition and variant conventions.

Desktop Base UI focus guards are the only scan exclusion: empty, 1px clipped sentinel spans, never component content. Their focus redirection is tested separately; mobile guards stay in the audit; no axe rule is disabled. [Upstream explanation](https://github.com/mui/base-ui/issues/4668).

## Motion

Motion for React (`motion/react`, the current Framer Motion package) supplies interruptible springs. CSS handles short presses and native Base UI presence. The package follows [Jakub's motion guidance](https://jakub.kr/components/animating-icons) and uses the same Motion version as Meal Planner.

Wrap the review or application root in `MotionProvider`. Components also work without it and respect the OS preference. Storybook's **System motion / Reduced motion** toolbar can reduce motion further; it cannot override an OS preference to reduce it. Preference changes apply to mounted components. Native Base UI keeps focus, gestures, stacking and mounting ownership.

[Primitive-by-primitive decisions](MOTION.md) cover movement, deliberate stillness, timing and reduced-motion behavior. Existing text, icons and native selected/checked states remain the source of meaning; motion only reinforces them.
