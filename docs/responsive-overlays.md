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

- `mobileSide="bottom"` is the default. The sidebar sets `mobileSide="left"` so its opening edge and dismissal gesture agree.
- `desktop="panel" breakpoint="lg"` keeps the workbench docked and non-modal at 1024px and wider. On smaller screens it becomes a modal drawer. Its portal container stays the same across breakpoints.
- `mobileLayout="panel"` on content gives workbench/settings interiors the available height and lets their existing scroll areas own scrolling. Ordinary forms use the default content-sized, scrollable body.
- `dismissible={false}` blocks closing by gesture, Escape, outside press or a close control while a save or other protected operation is pending. Continue to keep operation-specific guards in the feature.
- Pass `initialFocus` or `finalFocus` for a specific focus target. Desktop defaults to the first focusable element; mobile defaults to the popup to avoid opening the keyboard unexpectedly. An explicit input `autoFocus` still takes precedence.

The responsive policy lives in `responsive-overlay.tsx`; mobile geometry, safe areas, drag offsets, motion and the shared handle live in `styles.css`. Base UI owns pointer/scroll arbitration, focus containment/return, dismissal, and virtual-keyboard handling. The same mounted primitive tree is used at every width, preserving local drafts and mounted workbench content during resizing. Desktop gestures are disabled. Reduced-motion preferences remove transitions.

Do not add viewport checks in features or duplicate a form inside separate dialog/drawer branches. Menus, comboboxes and popovers remain anchored controls; they are not modal surfaces. For touch-interactive content such as a canvas or terminal, use Base UI's `data-base-ui-swipe-ignore` on that region when its gestures must not dismiss a drawer.

## Verify a change

Check at 320px, 390px and desktop width. Verify opening, the handle gesture, Escape, outside press policy, focus return, scrolling and form input. Resize with a draft still open and confirm its contents remain. Open nested confirmation/history dialogs and ensure the parent is protected. During a pending save, confirm that dismissal does not abandon it or repeat the mutation. Check the production CSS build as well as development styling.

Native touchscreen and software-keyboard behavior should also be checked on a physical phone. Desktop browser gesture simulation does not prove those device-specific interactions.

References: [Base UI Drawer](https://base-ui.com/react/components/drawer), [shadcn Drawer](https://ui.shadcn.com/docs/components/base/drawer).
