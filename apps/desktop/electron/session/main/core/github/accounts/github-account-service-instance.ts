import { clearOctokitCache } from '../services/octokit-cache';
import { GitHubAccountService } from './github-account-service';
import { githubVaultAccountStore } from './github-vault-accounts';

export const githubAccountService = new GitHubAccountService(githubVaultAccountStore, clearOctokitCache);
