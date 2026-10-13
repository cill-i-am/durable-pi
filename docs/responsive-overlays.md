# Responsive overlays

Use the existing `Dialog`, `Sheet` and `AlertDialog` components from `@/components/ui`. They all use `ResponsiveOverlay`, backed by the installed Base UI Drawer. Features do not select separate mobile and desktop trees.

```tsx
<Dialog open={open} onOpenChange={setOpen} dismissible={!saving}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Edit project</DialogTitle>
      <DialogDescription>Update the project details.</DialogDescription>
    </DialogHeader>
    <ProjectForm />
  </DialogContent>
</Dialog>
```

The example is a centered dialog on desktop and a bottom drawer below 768px. Keep normal shadcn composition, including titles, descriptions, triggers and close buttons. Use `AlertDialog` for confirmations: its role, modal focus handling, outside-press protection and explicit confirmation action are retained. Swiping dismisses a confirmation; it never confirms the action.

## Presentation options

- Mobile overlays always open from the bottom, including navigation, menus, submenus and selects. There is no per-feature edge setting.
- `desktop="panel" breakpoint="md"` keeps the workbench docked and non-modal at 768px and wider. Below 768px it becomes a modal bottom drawer. Its portal container stays the same across breakpoints.
- `mobileLayout="panel"` on content gives workbench/settings interiors the available height and lets their existing scroll areas own scrolling. Ordinary forms use the default content-sized, scrollable body.
- `dismissible={false}` blocks closing by gesture, Escape, outside press or a close control while a save or other protected operation is pending. Continue to keep operation-specific guards in the feature.
- Pass `initialFocus` or `finalFocus` for a specific focus target. Desktop defaults to the first focusable element; mobile defaults to the popup to avoid opening the keyboard unexpectedly. An explicit input `autoFocus` still takes precedence.

The responsive policy lives in `responsive-overlay.tsx`; mobile geometry, safe areas, drag offsets, motion and the shared handle live in `styles.css`. Base UI owns pointer/scroll arbitration, focus containment/return, dismissal, and virtual-keyboard handling. The same mounted primitive tree is used at every width, preserving local drafts and mounted workbench content during resizing. Desktop gestures are disabled. Reduced-motion preferences remove transitions.

The route-mounted workbench waits for its actual dock element before opening or creating its portal. An explicit `null` container prevents Base UI from falling back to the document body. Desktop entry slides from the right while the dock grows over 200ms, matching the sidebar's timing; its interior keeps its final width so text does not reflow during the slide. Only the dock viewport clips the animation, allowing portaled menus to extend beyond it. Mobile entry uses Base UI's existing 300ms bottom-drawer transition. Opening animation does not change the URL, run tools or remount content on a tab change. Closing updates the URL immediately, then retains the last panel and its route selection only until Base UI calls `onOpenChangeComplete(false)`. The retained dock is inert. Desktop exit slides right while its width collapses over 200ms; mobile exits downward through the native 300ms drawer transition. Native completion removes the view and returns focus to the workbench trigger. Reopening cancels cleanup of the old close, and the agent-keyed workspace prevents a retained view crossing bot ownership. Reduced motion removes transitions and still completes cleanup. Do not add a timer, delay navigation or use the retained presentation as permission to run an action.

Do not add viewport checks in features or duplicate a form inside separate dialog/drawer branches. The shared `DropdownMenu` and `Select` components keep their native state and keyboard semantics, and use `ResponsivePopup` to present their content in a mobile drawer. Desktop menus and selects remain anchored. For touch-interactive content such as a canvas or terminal, use Base UI's `data-base-ui-swipe-ignore` on that region when its gestures must not dismiss a drawer.

## Nested navigation and actions

Base UI 1.9 owns the drawer stack. A controlled parent yields modal focus ownership while its child Settings or Security panel is open; it stays mounted. This also applies when resizing an open desktop workbench to mobile. Child roots must be React descendants of their parent root; portal location alone does not establish nesting. The sidebar root wraps the workspace, Settings owns Security and its agent editor, and the workbench provides an `overlays` slot for Settings. A child drawer dims and scales its parent, blocks interaction behind it, and returns to the parent on dismissal. Do not close the parent before opening a child.

Mobile menu items that close the menu run their action after the exit animation. This sequences menu-to-dialog navigation and avoids overlapping sibling focus/stack updates. Submenus share the outer menu's pending action so selection runs once even when both menus close. Items with `closeOnClick={false}` run immediately. Keep event cancellation out of deferred actions; choose `closeOnClick={false}` when an action must retain the menu. Desktop actions remain immediate.

`mobileTitle` gives a menu or select drawer an accessible title when its default title is insufficient. Supply native Select `items` when values need labels before the popup has mounted. No feature needs a mobile-only picker implementation.

## Verify a change

Check at 320px, 390px and desktop width. Verify opening, the handle gesture, Escape, outside press policy, focus return, scrolling and form input. Resize with a draft still open and confirm its contents remain. Open nested confirmation/history dialogs and ensure the parent is protected. During a pending save, confirm that dismissal does not abandon it or repeat the mutation. Check the production CSS build as well as development styling.

Native touchscreen and software-keyboard behavior should also be checked on a physical phone. Desktop browser gesture simulation does not prove those device-specific interactions.

References: [Base UI Drawer](https://base-ui.com/react/components/drawer), [shadcn Drawer](https://ui.shadcn.com/docs/components/base/drawer).

Parent sizing: retain the parent’s own layout (`height: 100%` for panels, content height for menus) while a nested drawer is open. Do not assign a measured drawer height or `--drawer-frontmost-height` to the parent: a short menu would collapse a full-height Settings or navigation drawer. Verify parent geometry and retained scroll position before, during and after opening shorter children, not just the visible child and focus return.


### Workbench navigation correction — 13 October 2026

The workbench now uses a second shadcn Sidebar on desktop, with a compact icon rail and an explicit expand control. Browser, Terminal, Files, Apps, Activity, Checklists, Memory, Code and Routines are native links with an active-page indicator. The rail replaces the five tabs and separate overflow menu. At widths from 768px, the workbench remains beside the conversation; it no longer unexpectedly becomes a full-screen modal at a narrow desktop width.

On mobile, one labelled tool Select replaces the compressed tab strip. Its existing Base UI popup opens as a nested bottom drawer above the workbench. The content, route selection, operation guards, retained exit animation and focus return still use their existing owners. No new viewport branch is required in a feature.
