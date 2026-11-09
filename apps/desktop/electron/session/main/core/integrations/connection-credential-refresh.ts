import {accessTokenExpiresSoon,mcpOAuthCredentialsSchema,toIntegrationCredentials} from '@gugu/session-plugins/integrations';
import type {IntegrationAccountRecord,IntegrationCredentialStore} from './integration-credential-store';
import {refreshMcpCredentials} from './mcp-oauth-flow';

type Store=Pick<IntegrationCredentialStore,'getAccount'|'compareAndSwapAccount'>;
export async function refreshIntegrationAccount(input:{store:Store;pending:Map<string,Promise<IntegrationAccountRecord|null>>;
  refresh?:typeof refreshMcpCredentials},integrationId:string,accountId:string|undefined,enabled:boolean):Promise<IntegrationAccountRecord|null> {
  const account=await input.store.getAccount(integrationId,accountId);
  if(!account||!enabled)return account;
  const parsed=mcpOAuthCredentialsSchema.safeParse(account.credentials);
  if(!parsed.success||!accessTokenExpiresSoon(parsed.data))return account;
  const key=`${integrationId}:${account.accountId}`;
  const inFlight=input.pending.get(key);
  if(inFlight)return inFlight;
  const refresh=(async()=>{
    const refreshed=await(input.refresh??refreshMcpCredentials)(parsed.data);
    const next={...account,credentials:toIntegrationCredentials(refreshed)};
    // The person may have disconnected or authorized again while this was on the
    // network: their change wins. The caller gets what is stored now (nothing after a
    // disconnect, the new authorization after a reauthorization), never the stale grant.
    if(!await input.store.compareAndSwapAccount(integrationId,account,next.credentials))return input.store.getAccount(integrationId,account.accountId);
    return next;
  })().finally(()=>input.pending.delete(key));
  input.pending.set(key,refresh);
  return refresh;
}
