export function requestAt(rect, selection) {
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width ?? 0, height: rect.height ?? 0 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...selection,
  }
}
