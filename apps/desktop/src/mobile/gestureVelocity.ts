type Point = { x: number; y: number; at: number }

/** Release velocity in CSS pixels/second over the last 90ms, including the release itself. */
export class GestureVelocity {
  private points: Point[] = []
  add(x: number, y: number, at: number) {
    this.points.push({ x, y, at })
    while (this.points.length > 2 && this.points[0].at < at - 90) this.points.shift()
  }
  read() {
    const first = this.points[0], last = this.points[this.points.length - 1]
    if (!first || !last || last.at - first.at < 8) return { x: 0, y: 0 }
    const seconds = (last.at - first.at) / 1000
    return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds }
  }
}

export const PHONE_FLICK_SPEED = 500

export function completesPhoneBack(distance: number, width: number, velocity: number): boolean {
  return distance > 8 && (velocity > PHONE_FLICK_SPEED || (distance > width / 2 && velocity > -PHONE_FLICK_SPEED))
}
