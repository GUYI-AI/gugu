# Calendar build-only diagnostic

This directory belongs only to `diag/ios-calendar-build-only-20261108`. Do not merge this diagnostic workflow replacement into `dev` or `main`.

The reviewed source is based on `91ac8333415b688916669047bd3940ef49cfda11`, the two D-owned XCTest files from `c1861dec9da674aee8012f2c3f767575263d5de4`, and the v3 UI overlay archive `2be79185308f845bc24c073cbbc0af37f309c49d803f505024d8a0c4db9c35a5`. App production sources remain at the base. The public backend snapshot is exactly `adf2fe6d86c12c7cee5e585bb288cb77280d49643e7be0098f255f13b112e71b`; it contains only a preproduction URL and a public role=anon key. No user password, access token, refresh token or owner session is an input.

The one manually dispatched GitHub-hosted `macos-26` job is sequential:

1. Bind the exact reviewed commit, isolated build roots, selected Xcode 26.6/17F113 and one public configuration snapshot.
2. Copy and run only the existing eleven offline file-protocol cases outside the source tree.
3. Compile the exact UI target's `RuntimeUITimePolicy.swift` with the fifteen CLT probes, then run that CLI probe binary. This does not execute UI code.
4. Install the normal frozen pnpm lock, then run the existing prepare-ios-backend, renderer, phone-web-dir, build-ios-agent and `cap copy ios` path. Never run `cap sync`.
5. Resolve pinned Swift packages and use the new `IOSCalendarBuildValidation` aggregation scheme for `build-for-testing` with one SDK build job. It builds the real App, original HostValidation target and new CalendarUIValidation target; it never calls a test action.
6. Archive original products and xctestrun bytes, inspect actual configuration/renderer/a6 runtime, Calendar purpose declarations, Mach-O UUIDs and ad-hoc Simulator signatures. Preserve logs/status/artifacts even when a later check fails.

The v3 overlay's CalendarUIValidation scheme is kept verbatim. The additional aggregation scheme references only the three existing/new targets and sets buildForTesting=YES, all other build purposes=NO. It adds no production target or launch action. Both original App and HostValidation target objects remain unchanged.

`input-manifest.json` freezes changed input bytes. The workflow is bound by its complete reviewed commit instead of embedding a self-referential workflow hash. It records its actual workflow and manifest hashes at runtime. An explicit `expected_revision` must equal the selected branch SHA and GitHub SHA.

There is no App launch, Simulator creation/boot, XCTest execution, authentication, EventKit, model request, push delivery, cloud cleanup or TestFlight action in this workflow. Build checks do not prove UI/permission/final App environment behavior. The original v1/v2 failed source paths and earlier successful/failed hosted runs retain their own scope.

Public artifact contents are source/build logs, public configuration hashes, CLT outputs and SDK products. Do not add real account credentials or private UI evidence to this job. A separate reviewed run-only parent, exact products, actual runtime, owned device and execution window are required for later private UI work.

Tracking: public client issue #1877. This local preparation does not authorize a push, dispatch, PR or merge.
