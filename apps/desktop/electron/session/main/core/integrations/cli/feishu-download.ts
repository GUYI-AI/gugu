import { FEISHU_BINARY_SHA256, FEISHU_CLI_VERSION, feishuArchiveName } from './feishu-cli';
import type { CliPlatform } from './cli-tools';

/** Mirrors must serve the original release bytes. Only transport errors allow fallback. */
export async function downloadFeishuBinary(
  platform: CliPlatform,
  download: (url: string) => Promise<string>,
): Promise<void> {
  const archive = feishuArchiveName(platform);
  const sources = [
    `https://registry.npmmirror.com/-/binary/lark-cli/v${FEISHU_CLI_VERSION}/${archive}`,
    `https://github.com/larksuite/cli/releases/download/v${FEISHU_CLI_VERSION}/${archive}`,
  ];
  const failures: string[] = [];
  for (const url of sources) {
    let digest: string;
    try {
      digest = await download(url);
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    if (digest !== FEISHU_BINARY_SHA256[platform]) throw new Error(`${archive} integrity mismatch`);
    return;
  }
  throw new Error(`Could not download ${archive}. ${failures.join('; ')}`);
}
