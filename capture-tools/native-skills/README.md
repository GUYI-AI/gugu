# C skills: prepared isolated verification entries

Prepared only. No browser, scanner server or Electron instance has been started by this delivery.
Default repository CI collection is unchanged. No dependencies are installed by these entries.

## 1. Real files into the real creation page

From an acquired, clean mac1 gate containing the final integrated source and matching existing dependencies:

```sh
GUGU_SKILLS_CAPTURE_ROOT=<existing-private-task-directory> \
PLAYWRIGHT_BROWSERS_PATH=/Users/mac1/gates/.phone-menu-bar-2858/browsers \
pnpm exec vitest run --config capture-tools/native-skills/vitest.config.ts --project session-browser
```

Run this command through the existing resource guard, `nice`, one worker, double-fresh admission,
and the authorized window including cleanup. Do not substitute a different browser/dependency version.
Do not run it on MBP. A refused admission or guard termination ends that round.

The setup server creates its own unique directory under the explicit private task directory,
writes real `SKILL.md` fixtures, calls the unmodified production `readNativeCreationSkills`, and
returns its actual results over a loopback HTTP boundary. It never reads the user's home/project.
The browser mounts actual `CreateSessionPage → Thread → CreateTarget → CreateSkillsList` with
the real locale catalogs, replica, native result decoder, filter and portalled sheet.
Account/device/model/create boundaries are controlled; attempted agent creation throws.

Three cases (two themes plus a real malformed-file/retry case) prepare eight PNGs:
read/search/no-match in light/dark, real scan failure and same-context retry recovery in dark.
They live under `__screenshots__/owner-phone-regression/C-new-*`.

This is actual filesystem scanning plus actual creation-page rendering with controlled transport.
It is **not** the running MBP, a registered production RPC host, the phone's network transport,
or a created-agent page. Those boundaries remain unverified even if this capture passes.
Phone/Probe must run the same entry after integrating the final candidate; local images from
different heads must not be assembled into final acceptance. The created-agent entry needs its
own actual parent-page capture in the integrated candidate.

## 2. One actual native RPC on an owned isolated host

`isolated-host-read.mjs` operates only on an **already launched**, owned isolated Electron.
It neither launches an app nor changes owner UI/services. A launcher must first provide a receipt:

```json
{
  "isolationRoot": "<private-task-root>",
  "executable": "<private-task-root>/app/Gugu.app/Contents/MacOS/Gugu",
  "pid": 12345,
  "startTime": "<exact ps lstart>",
  "guguHome": "<private-task-root>/gugu-home",
  "userData": "<private-task-root>/user-data",
  "osHome": "<private-task-root>/home",
  "codexHome": "<private-task-root>/home/.codex",
  "cdpPort": 12346,
  "targetId": "<own app page id from this listener>",
  "sourceSha": "5a2041030c366bf468e1276e34c9ab39c9d55b78",
  "appVersion": "0.3.6-beta.43892205063.1",
  "expectedSkillNames": ["会议记录", "代码检查"]
}
```

The executable and all data paths must physically resolve inside the private root. The receipt
is an attribution input, not independent source attestation: verify the app archive/signature
against the frozen manifest before launching it. Use an allowlisted child environment and set
`GUGU_HOME`, `GUGU_USER_DATA_DIR`, `HOME`, `CODEX_HOME`, and `GUGU_DEBUG_PORT` in the final merged
environment; pass matching `--user-data-dir`. Do not copy owner auth/profile or sign in.
Seed only the private Codex/`.agents` directories with the isolated fixture skill files.

```sh
node capture-tools/native-skills/isolated-host-read.mjs <receipt.json> <private-task-root>/results/native-read.json
```

The script verifies exact PID/executable/birth, actual effective isolation variables, CLI override,
CDP listener ownership and loaded application version before invoking
`sessionTimeline.sessionCreateSkills({harness:'codex'})` exactly once. It saves the returned
native error code/message or actual private-file catalog, with source/version/context metadata.
An empty catalog or missing seeded skill names fails; an out-of-root catalog is refused without saving its contents.
It rejects the known owner PID and any executable/data path outside the private root. It never
reloads or closes the app; the launch owner retains exact process cleanup responsibility.

This private default-directory case is independent of the historical owner's project selection.
Per the supervisor's 02:36 decision, that historical project is no longer a prerequisite for
confirming the already-proven missing-method incompatibility. Do not use this script on owner MBP.

## Still required

- Phone's capability/missing-method feedback and same-context retry contract, including same-version
  missing-method refusal distinct from genuine old-host compatibility.
- Actual isolated host RPC execution with fixed source/archive provenance; no execution yet.
- Final integrated creation and created-agent page screenshots, success/search/retry and unchanged draft.
- Authorized MBP upgrade window followed by real same-target success. No upgrade is executed here.
