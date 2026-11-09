import type PhotoSwipe from 'photoswipe'
import { bindFileZoom, readFileZoom, writeFileZoom, zoomForCommand } from './file-content-zoom'

/**
 * The image reading zoom: a ratio over `zoomLevels.initial`, which stays what PhotoSwipe means by the whole image.
 * Slides read it when PhotoSwipe places them at their initial zoom. Only a zoom to read by writes it: not a resize, a touch pinch or a double click's peek.
 */
export function wireReadingZoom(pswp: PhotoSwipe): void {
  pswp.on('initialZoomPan', ({ slide }) => {
    const { initial, max } = slide.zoomLevels
    const level = Math.min(max, initial * readFileZoom('image'))
    slide.setZoomLevel(level)
    // Laid out at this size, as after any zoom: a later resize then keeps it instead of rescaling by the new initial.
    slide.currentResolution = level
    slide.updateContentSize()
    slide.pan.x = slide.bounds.center.x
    slide.pan.y = slide.bounds.center.y
  })
  // A slide paged to may have been placed before the last zoom. The first slide also activates during init: that one belongs to the opening.
  pswp.on('slideActivate', ({ slide }) => {
    if (!pswp.opener.isOpen) return
    slide.zoomAndPanToInitial()
    slide.applyCurrentZoomPan()
  })
  pswp.on('beforeZoomTo', ({ destZoomLevel }) => {
    const levels = pswp.currSlide?.zoomLevels
    if (!levels || !pswp.opener.isOpen || destZoomLevel === levels.secondary) return
    const level = Math.min(levels.max, destZoomLevel)
    const ratio = Math.max(1, level / levels.initial)
    // Held at this image's cap, a larger preference that a bigger image can honour survives.
    if (level === levels.max && readFileZoom('image') >= ratio) return
    writeFileZoom('image', ratio, pswp.element)
  })
  pswp.on('afterInit', () => {
    if (!pswp.element) return
    const offCommand = bindFileZoom(pswp.element, command => {
      const slide = pswp.currSlide
      if (!slide) return
      const { initial } = slide.zoomLevels
      slide.zoomTo(initial * Math.max(1, zoomForCommand(slide.currZoomLevel / initial, command)), undefined, 0)
    })
    pswp.on('destroy', offCommand)
  })
}
