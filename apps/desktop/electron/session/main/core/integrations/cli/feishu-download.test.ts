import { describe, expect, it, vi } from 'vitest';
import { FEISHU_BINARY_SHA256, FEISHU_CLI_VERSION, feishuArchiveName } from './feishu-cli';
import { downloadFeishuBinary } from './feishu-download';
import type { CliPlatform } from './cli-tools';

const platform: CliPlatform = 'darwin-arm64';
const archive = feishuArchiveName(platform);
const mirror = `https://registry.npmmirror.com/-/binary/lark-cli/v${FEISHU_CLI_VERSION}/${archive}`;
const upstream = `https://github.com/larksuite/cli/releases/download/v${FEISHU_CLI_VERSION}/${archive}`;

describe('pinned Feishu binary sources', () => {
  it.each(Object.keys(FEISHU_BINARY_SHA256) as CliPlatform[])('uses only the mirror on a verified %s download', async (target) => {
    const download = vi.fn().mockResolvedValue(FEISHU_BINARY_SHA256[target]);
    await downloadFeishuBinary(target, download);
    expect(download.mock.calls).toEqual([[
      `https://registry.npmmirror.com/-/binary/lark-cli/v${FEISHU_CLI_VERSION}/${feishuArchiveName(target)}`,
    ]]);
  });

  it('falls back to the original GitHub release after a transport failure', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValueOnce(FEISHU_BINARY_SHA256[platform]);
    await downloadFeishuBinary(platform, download);
    expect(download.mock.calls).toEqual([[mirror], [upstream]]);
  });

  it('rejects a corrupt mirror archive without trying another source', async () => {
    const download = vi.fn().mockResolvedValueOnce('0'.repeat(64)).mockResolvedValueOnce(FEISHU_BINARY_SHA256[platform]);
    await expect(downloadFeishuBinary(platform, download)).rejects.toThrow(`${archive} integrity mismatch`);
    expect(download.mock.calls).toEqual([[mirror]]);
  });

  it('also checks the fallback against the committed digest', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('HTTP 404')).mockResolvedValueOnce('0'.repeat(64));
    await expect(downloadFeishuBinary(platform, download)).rejects.toThrow(`${archive} integrity mismatch`);
    expect(download.mock.calls).toEqual([[mirror], [upstream]]);
  });

  it('preserves both transport errors when neither source can be downloaded', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('mirror offline')).mockRejectedValueOnce(new Error('upstream offline'));
    await expect(downloadFeishuBinary(platform, download)).rejects.toThrow(
      `Could not download ${archive}. ${mirror}: mirror offline; ${upstream}: upstream offline`,
    );
  });
});
