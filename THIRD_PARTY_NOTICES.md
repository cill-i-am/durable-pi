# Third-party notices

The heap and linked-view merge in `src/memory/domain.ts` is adapted from [VictorTaelin/UniiChat](https://github.com/VictorTaelin/UniiChat/blob/0500bf6a8ea4bf0ce047488562022b1b6532cc30/Memory.ts).

Copyright 2026 Higher Order Company. Licensed under the Apache License, Version 2.0; see [the license](licenses/UniiChat-Apache-2.0.txt).

Modifications: use Durable Pi range/node types and Effect execution, preserve leftmost tie ordering, and integrate with the existing durable memory policy.

The agent avatar in `packages/ui/src/components/agent-avatar.tsx`, its pure helpers in `packages/ui/src/lib/dither-avatar.ts`, and the dither palette in `packages/ui/src/styles/globals.css` are adapted from [dithercn](https://dithercn.dev/docs/interface/avatar), retrieved through its shadcn registry on 2026-10-26.

Copyright 2026 Leo and Shadcn Labs. Licensed under the MIT License; see [the license](licenses/dithercn-MIT.txt).

Modifications: shared-package imports and agent-specific exports, only the SVG avatar's required helpers, bounded path caching, logical group overlap and presence positioning, reduced-motion support, and finite nonnegative group limits. Agent IDs seed the faces while display names provide accessible labels.
