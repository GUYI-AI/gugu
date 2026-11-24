import { cancelFrame, frame, frameData, spring } from 'framer-motion';

/** The spring every panel move plays: half a second, a touch of give, no visible overshoot. */
export const PANEL_SPRING = { duration: 0.5, bounce: 0.1 } as const;

/**
 * @@@frame-clock — a move's time is the frames it is shown in. Each frame advances it by the frame loop's delta, which the
 * loop already caps (a frame held back by a first mount or a long task counts as one short step), ❌ wall time since the
 * start: a first open whose pages mount for the first time painted its first frame most of the way there (owner 11-23).
 */
export function playSpring(onUpdate: (progress: number) => void, onComplete: () => void): { stop(): void } {
  const curve = spring({ keyframes: [0, 1], duration: PANEL_SPRING.duration * 1000, bounce: PANEL_SPRING.bounce });
  let elapsed = 0;
  const step = () => {
    elapsed += frameData.delta;
    const { value, done } = curve.next(elapsed);
    if (!done) return onUpdate(value);
    cancelFrame(step);
    onComplete();
  };
  frame.update(step, true);
  return { stop: () => cancelFrame(step) };
}
