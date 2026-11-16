import {
  CloudComputerError,
  cloudComputerBaseUrl,
  createCloudComputerClient,
  type CloudComputerClient,
} from '@gugu/core/cloud/cloudComputer'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { cloudComputerEnabled } from '@gugu/core/cloud/optionalServices'
import { authBoundedFetch } from './authBoundedFetch'
import { getRendererAccessToken } from './sessionPublication'

/** #7199 到云电脑管家的那一条:`GUGU_CLOUD_COMPUTER_URL`,否则 `/functions/v1/cloud-computer`;都没有 = null。请求跟着登录态走(authBoundedFetch)。 */
function overrideUrl(): string {
  return typeof __GUGU_CLOUD_COMPUTER_URL__ === 'string' ? __GUGU_CLOUD_COMPUTER_URL__ : ''
}

function supabaseUrlOrNull(): string | null {
  try {
    return getSupabaseUrl()
  } catch {
    return null
  }
}

let cached: { baseUrl: string; client: CloudComputerClient } | null = null

export function rendererCloudComputerClient(): CloudComputerClient | null {
  const baseUrl = cloudComputerBaseUrl({ enabled: cloudComputerEnabled(), override: overrideUrl(), supabaseUrl: supabaseUrlOrNull() })
  if (!baseUrl) return null
  if (cached?.baseUrl === baseUrl) return cached.client
  const client = createCloudComputerClient({
    baseUrl,
    accessToken: async () => {
      const token = getRendererAccessToken()
      if (!token) throw new CloudComputerError(0, 'unauthorized', 'Not authenticated')
      return token
    },
    anonKey: getSupabaseAnonKey(),
    fetch: authBoundedFetch,
  })
  cached = { baseUrl, client }
  return client
}
