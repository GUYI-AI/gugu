import { egress } from '@gugu/core/shared/egress';
import { extensionsService } from '@main/core/extensions/extensions-root';
import { githubDefaultCredential } from '@main/core/github/accounts/github-token-vault-instance';
import { passwordVaultForHost } from '../../../../password-vault/beta-host';
import { createAppCredentials } from './app-credentials';
import { invokeInEmbedder } from './extension-bridge-relay';
import { EXTENSION_CHOOSE_CREDENTIAL_METHOD } from '@shared/extensions/host-actions';

export const appCredentials = createAppCredentials({
  declarations: (extensionId) => extensionsService().get(extensionId).manifest.permissions?.credentials ?? [],
  grantedHosts: (extensionId) => extensionsService().grantedHosts(extensionId),
  picked: (extensionId, site) => extensionsService().credentialChoice(extensionId, site),
  pick: (extensionId, site, credentialId) => extensionsService().setCredentialChoice(extensionId, site, credentialId),
  saved: (site) => passwordVaultForHost.list(site),
  secret: (credentialId) => passwordVaultForHost.secret(credentialId),
  save: (input) => passwordVaultForHost.save(input),
  ask: (page, ask) => invokeInEmbedder(page.embedderId, EXTENSION_CHOOSE_CREDENTIAL_METHOD, ask).then(() => undefined),
  connectorDefault: githubDefaultCredential,
  fetch: (url, init) => egress.fetch(url, init),
});
