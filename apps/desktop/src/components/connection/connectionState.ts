/**
 * The connection state a header shows for the machine a page reads from — one shared vocabulary for phone and desktop.
 *
 * owner 2026-11-08: no 「未连接」, only explicit states — 「连接中」「设备离线」 — rendered in the page header, never as a
 * banner. Three states, two separate facts behind them:
 *
 * - `online`         the page's link to the machine answers.
 * - `connecting`     the link does not answer yet / any more, but nothing says the machine is off: the directory still
 *                    lists it online (its lease outlives a crash by about two minutes), this computer's own network is
 *                    down, or a cloud computer is being woken. The reads keep retrying; ❌ no 「最后在线」 here — an old
 *                    observation is not evidence the device is off.
 * - `device_offline` the device directory (gugu_devices) says the machine is off, or a cloud computer could not be woken.
 *
 * Agent activity (running / waiting / needs you) is a different axis and keeps its own glyphs and colors.
 */
export type ConnectionState = 'online' | 'connecting' | 'device_offline'

export interface ConnectionFacts {
  /** The page's own link to the machine answers (RPC / window frames arrive). `undefined` = the page has no link of its own. */
  answering?: boolean
  /** The device directory's reading (`Device.is_online`). */
  deviceOnline: boolean
  /** This computer's / phone's own network (`navigator.onLine`). */
  networkOnline?: boolean
  /** A cloud computer that is asleep or being woken. */
  cloudWaking?: boolean
  /** A cloud computer that could not be woken (the wake attempt failed). */
  cloudWakeFailed?: boolean
}

/** Derives the header state from the facts, in this order: link answers → wake failed → own network / waking → directory. */
export function connectionStateOf(facts: ConnectionFacts): ConnectionState {
  if (facts.answering === true) return 'online'
  if (facts.cloudWakeFailed) return 'device_offline'
  if (facts.networkOnline === false || facts.cloudWaking) return 'connecting'
  if (!facts.deviceOnline) return 'device_offline'
  return facts.answering === false ? 'connecting' : 'online'
}
