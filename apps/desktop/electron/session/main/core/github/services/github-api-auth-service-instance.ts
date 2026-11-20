import { githubVaultAccountStore } from '../accounts/github-vault-accounts';
import { GitHubApiAuthService } from './github-api-auth-service';

export const githubApiAuthService = new GitHubApiAuthService(githubVaultAccountStore);
