import {
  opencodeFamilyAuthStatus,
  opencodeFamilyModelCredential,
} from '../../helpers/opencode-family-credential';

export const kilocodeVendorKeyAccount = { envVars: ['KILO_API_KEY'], unsetEnv: ['KILO_API_KEY'] };

/** `kilo auth list` ends with `N credentials`, stored in `~/.local/share/kilo/auth.json` (measured 7.8.27). */
export const kilocodeAuthStatus = opencodeFamilyAuthStatus();

export const kilocodeModelCredential = opencodeFamilyModelCredential({
  dataDirName: 'kilo',
  configFileBase: 'kilo',
  // Kilo's own gateway is built in, so it is not in the models.dev snapshot (kilo-sessions.ts reads this variable).
  builtinProvider: { id: 'kilo', envVars: kilocodeVendorKeyAccount.envVars },
});
