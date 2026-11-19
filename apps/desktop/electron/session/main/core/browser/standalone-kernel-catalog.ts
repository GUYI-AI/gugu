import type { StandaloneKernelAsset } from './standalone-kernel-installer';

// Full official CfT archive and domestic mirror independently verified, 2026-11-19.
export const STANDALONE_MAC_ASSET: StandaloneKernelAsset = {
  version: '158.0.8127.36', platform: 'darwin-arm64', bytes: 200_339_070,
  sha256: 'b86d3b393def1f87d369b022abff0a51acb015d6fcb79ddfd1c379c9d72fbbe2',
  url: 'https://cdn.npmmirror.com/binaries/chrome-for-testing/158.0.8127.36/mac-arm64/chrome-mac-arm64.zip',
};
