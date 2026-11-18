export function messageRangeLabel(range: { start: number; count: number }) {
  const first = (range.start + 1).toLocaleString()
  if (range.count === 1) return `Message ${first}`
  const last = (range.start + range.count).toLocaleString()
  return `Messages ${first}–${last}`
}
