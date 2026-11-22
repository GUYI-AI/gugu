import { net } from 'electron';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { githubDefaultCredential } from '@main/core/github/accounts/github-token-vault-instance';
import { passwordVaultForHost } from '../../../../password-vault/beta-host';
import { createAppCredentials } from './app-credentials';

export const appCredentials = createAppCredentials({
  declarations: (extensionId) => extensionsService().get(extensionId).manifest.permissions?.credentials ?? [],
  grantedHosts: (extensionId) => extensionsService().grantedHosts(extensionId),
  picked: (extensionId, site) => extensionsService().credentialChoice(extensionId, site),
  pick: (extensionId, site, credentialId) => extensionsService().setCredentialChoice(extensionId, site, credentialId),
  saved: (site) => passwordVaultForHost.list(site),
  secret: (credentialId) => passwordVaultForHost.secret(credentialId),
  connectorDefault: githubDefaultCredential,
  fetch: (url, init) => net.fetch(url, init),
});
