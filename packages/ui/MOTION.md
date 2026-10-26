# Primitive motion

Motion reinforces a press, a selection or a change of context. It never delays input, moves a focused field, signals an outcome by itself or decides async progression. Static content has no automatic entrance or hover lift. Textures, frame anatomy, shadows and focus rings stay intact.

Review each component in Storybook with **System motion**, then **Reduced motion**, in Light/Night and phone/desktop. The OS reduced-motion preference always takes priority, including changes while a component is mounted.

| Primitive | Decision | Reduced motion |
| --- | --- | --- |
| Button | Interruptible 0.96 press scale, 150ms ease-out; texture supplies the pressed cue. Disabled and `static` buttons do not scale. | No scale; pressed texture remains. |
| Checkbox | Native checked/indeterminate state drives a 100ms opacity fade and 300ms geometry spring, without mount animation or mirrored checked state. | Opacity only; the check or mixed icon remains. |
| Switch | Native checked state moves the thumb with a short, non-bouncy spring; RTL reverses direction. | Thumb snaps to its actual selected position. |
| ToggleGroup | A short shared selection spring is scoped to each single-selection group. Multiple selection uses independent backgrounds. | Local opacity fade; no travelling indicator. |
| Tabs | Base UI’s measured selection highlight retargets over 150ms with the shared ease, including vertical and wrapped lists. Labels, focus and panels update immediately; no entrance on mount. | The highlight moves directly to the selection without interpolation, including live preference changes. |
| Input | Immediate text, caret, validation and focus. | Same. |
| Textarea | Immediate editing and resizing; no height tween while typing. | Same. |
| Field | Static grouping, labels, descriptions and validation. No moving error text or layout animation. | Same. |
| Label | Static association and immediate focus affordance. | Same. |
| Spinner | Continuous rotation only while consumers display a labelled working state. | Static arc; the working label remains. |
| Select | Desktop popup fades over 100ms; options and keyboard selection respond immediately. Phone uses the native bottom sheet. | Fade only, retaining native focus and selected state. |
| DropdownMenu | Desktop menus/submenus fade over 100ms, without zoom or travel. Phone uses native stacked sheets. | Fade only; selection and focus stay native. |
| Tooltip | 100ms opacity, without zoom, travel or blur. | Same short fade. |
| Dialog | Native presence: 200ms entrance at 0.98 scale; shorter 150ms exit at 0.99. | 100ms opacity only. |
| AlertDialog | Same restrained dialog motion. Modality and decisions remain native/consumer owned. | 100ms opacity only. |
| Sheet | Native directional slide, 200ms entrance/150ms exit. Phone retains direct manipulation, snap points and stacked positioning. | Automatic open/close fades over 100ms. Native dragging still follows the finger; stack geometry remains. |
| Card | Still. Content surfaces do not rise or enter on their own. | Same. |
| CardFrame | Still. Headers, panels and exposed footers retain a single continuous rim. | Same. |
| Item | Interactive row background only, 100ms. No row/icon travel or hover action entrance. | Immediate background. |
| Table | Row background only, 100ms. Cells, headings, selection and layout remain immediate. | Immediate background. |
| Badge | Still. Status text and colour provide the cue. | Same. |
| Status | Still. Text and icon provide the cue; contextual icon transitions are opt-in through IconSwap. | Same. |
| Alert | Still. Live announcements and actions remain immediate. | Same. |
| Empty | Still. No decorative entrance or looping illustration. | Same. |
| Skeleton | Gentle loading pulse while mounted. Consumers own working announcements. | Static placeholder. |
| Separator | Still. Group boundaries never animate. | Same. |
| IconSwap | Opt-in contextual icon pair, 0.25↔1 scale and 4px blur use a 300ms spring with no bounce; a separate 100ms CSS opacity fade stays interruptible. Both layers stay mounted; no initial animation. | 100ms opacity only, no blur or scale. |

## Composition and ownership

`MotionProvider` is a plain MotionConfig boundary; source-exported components also work on their own. `useUIReducedMotion` subscribes to the native media query because Motion 14.3's own hook reads it once. Per-component reduced flags reach portals without depending on a DOM ancestor.

Base UI owns focus, input state, popup presence, gestures, snap geometry and restoration. Its CSS transitions remain interruptible; no second AnimatePresence or drag controller competes with the native drawer. Motion owns springs and ToggleGroup selection interpolation; Tabs uses Base UI’s measured indicator with CSS transitions. XState/Effect continues to own the asynchronous examination scenarios.

Use `IconSwap` inside an owner with a stable accessible name. Its layers are decorative; the parent exposes pressed/checked/selected state or visible status text. Do not animate navigation icons or frequently repeated row actions.

## References

- [Jakub: animating icons](https://jakub.kr/components/animating-icons)
- [Jakub: less is more](https://jakub.kr/writing/less-is-more)
- [Motion and Base UI](https://motion.dev/docs/base-ui)
- [Motion accessibility](https://motion.dev/docs/react-accessibility)
