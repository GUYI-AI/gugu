// Compile the optional SDK path in community CI without a real Firebase project.
// Firebase initialization stays disabled until signed-in notification consent.
import { writeFileSync } from 'node:fs'
const packageName = process.env.GUGU_TIER === 'beta' ? 'app.gugu.chat.beta' : 'app.gugu.chat'
writeFileSync('apps/mobile/android/app/google-services.json', JSON.stringify({
  project_info: { project_number: '100000000000', project_id: 'gugu-synthetic-ci' },
  client: [{ client_info: { mobilesdk_app_id: '1:100000000000:android:0000000000000000', android_client_info: { package_name: packageName } },
    api_key: [{ current_key: 'synthetic-key-no-firebase-authorization' }], services: { appinvite_service: { other_platform_oauth_client: [] } } }],
  configuration_version: '1',
}), { mode: 0o600, flag: 'wx' })
