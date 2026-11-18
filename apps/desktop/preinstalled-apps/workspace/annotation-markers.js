/** The host owns the annotation text and editor. This page only positions numbered source anchors. */
export function fileAnnotationMarkers({ anchor, label, viewport }) {
  const api = globalThis.gugu.files
  let file = null, markers = [], frame = 0, layer
  const place = () => {
    frame = 0
    if (!file || !markers.length) { layer?.replaceChildren(); return }
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'file-annotation-markers'
      document.body.append(layer)
    }
    const visible = viewport()
    const countAtLine = new Map()
    layer.replaceChildren(...markers.flatMap(marker => {
      const rect = anchor(marker.startLine)
      if (!rect || !visible || rect.bottom <= visible.top || rect.top >= visible.bottom) return []
      const ordinal = countAtLine.get(marker.startLine) ?? 0
      countAtLine.set(marker.startLine, ordinal + 1)
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.annotationMarker = marker.number
      button.ariaLabel = label(marker.number)
      button.textContent = marker.number
      button.style.left = `${Math.min(visible.right - 24, Math.max(visible.left, rect.left + ordinal * 24))}px`
      button.style.top = `${Math.max(visible.top, rect.top - 10)}px`
      button.addEventListener('pointerdown', event => event.preventDefault())
      button.onclick = () => {
        const at = button.getBoundingClientRect()
        void api.annotateSelection(file, requestAt(at, { id: marker.id })).catch(() => {})
      }
      return [button]
    }))
  }
  const refresh = () => { if (!frame && (markers.length || layer)) frame = requestAnimationFrame(place) }
  api.onAnnotationMarkers?.(value => {
    if (file?.id !== value.path) return
    markers = value.markers
    refresh()
  })
  window.addEventListener('resize', refresh)
  return {
    watch(entry) {
      if (file?.id === entry?.id && file?.workspace === entry?.workspace) return
      file = entry
      markers = []
      refresh()
      void api.watchAnnotationMarkers?.(entry ?? null)?.catch(() => {})
    },
    refresh,
  }
}

export function requestAt(rect, selection) {
  return {
    rect: { x: rect.left, y: rect.top, width: rect.width ?? 0, height: rect.height ?? 0 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...selection,
  }
}
