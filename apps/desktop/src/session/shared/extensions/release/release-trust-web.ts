// #1931 The release checks as the page (the desktop renderer, the phone) runs them: the market's contract from
// release-contract-web.mjs, which is the mirrored file with its crypto import pointed at release-crypto-web.ts. Page code
// imports the checks from here, never from release-contract.mjs, so nothing it loads imports a Node built-in
// (tests/unit/scripts/releaseContractWeb.test.ts holds that, and the built renderer is checked for Node shims).
import { verifyReleaseSignature } from './release-contract-web.mjs'
import { releaseChecks } from './release-trust'

export * from './release-trust'
export const { verifyMarketRelease, verifyReleaseProof } = releaseChecks(verifyReleaseSignature)
