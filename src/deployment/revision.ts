// Replaced by both production bundlers. Local/native fixtures need no stamp.
declare const __PI_BUILD_REVISION__: string
export const buildRevision =
  typeof __PI_BUILD_REVISION__ === "string"
    ? __PI_BUILD_REVISION__
    : "development"
