import { platform } from '../../platform'
import { LOCAL_HOST, PHONE_HOST } from '../../session/renderer/features/extensions/extensions-api'

/**
 * The host key of this device's Apps (`installedExtensions(HERE_HOST)`): main on the desktop, the phone's own App store on
 * the phone; none on the web, where Apps do not run. Decided by the platform alone (as `appsHere` is), in a module of its
 * own so a surface that only reads what is installed does not load the install / open machinery with it.
 */
export const HERE_HOST: string | null = platform.kind === 'electron' ? LOCAL_HOST : platform.capabilities?.mobileApps ? PHONE_HOST : null

/**
 * Where this window's installed Apps are listed, Apps running here or not: the phone's own store on the phone, else main
 * (the desktop's, or on the web the headless host's, which the session page lists for its tabs). The assistant entry and an
 * App's own page decide on it.
 */
export const LISTED_HOST: string = platform.capabilities?.mobileApps ? PHONE_HOST : LOCAL_HOST
