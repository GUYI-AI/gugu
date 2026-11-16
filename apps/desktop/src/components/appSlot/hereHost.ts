import { platform } from '../../platform'
import { LOCAL_HOST, PHONE_HOST } from '../../session/renderer/features/extensions/extensions-api'

/** The host key of this device's Apps (own module: reading what is installed ❌ loads the install machinery). */
export const HERE_HOST: string | null = platform.kind === 'electron' ? LOCAL_HOST : platform.capabilities?.mobileApps ? PHONE_HOST : null

/** Where this window's installed Apps are listed, running here or not: the phone's store, else main (or the web's host). */
export const LISTED_HOST: string = platform.capabilities?.mobileApps ? PHONE_HOST : LOCAL_HOST
