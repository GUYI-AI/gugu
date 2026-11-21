# repo-health

One scan of the whole repo with seven tools. `run.mjs` runs them, keeps each tool's own output, and writes one
`summary.json` that later scans are compared against.

```bash
node scripts/checks/repo-health/run.mjs --out <dir>                      # every tool
node scripts/checks/repo-health/run.mjs --out <dir> --skip stryker        # all but mutation testing
node scripts/checks/repo-health/run.mjs --out <dir> --only knip,jscpd
node scripts/checks/repo-health/run.mjs --out <dir> --coverage target/coverage/typescript/lcov.info
node scripts/checks/repo-health/report.mjs <dir> > <dir>/REPORT.md        # markdown tables from summary.json
```

| tool | dimension | config | pinned in |
|---|---|---|---|
| knip | `deadCode` | `knip.ts` | `package.json` |
| jscpd | `duplication` | `.jscpd.json` | `package.json` |
| dependency-cruiser | `deps` | `.dependency-cruiser.cjs` | `package.json` |
| type-coverage | `typeCoverage` | flags in `runners.mjs` | `package.json` |
| crapper (unclebob/crapper) | `complexity` | flags in `runners.mjs` | `tools.json` (Python) |
| repowise | `churn` | flags in `runners.mjs` | `tools.json` (Python) |
| Stryker | `mutation` | `stryker.config.mjs` | `package.json` |

## Coverage for crapper

crapper scores CRAP = CC² × (1 − coverage)³ + CC per function and reads LCOV. Produce it with the unit projects first:

```bash
pnpm exec vitest run --project gugu --project tooling --project session-packages --project session-main \
  --project session-chat-ui --coverage.enabled --coverage.provider=v8 --coverage.reporter=lcov \
  --coverage.reportOnFailure --coverage.reportsDirectory=target/coverage/typescript
```

Without `--coverage`, crapper runs complexity-only and CRAP equals CC.

## Python tools

crapper and repowise are installed into one venv (`node_modules/.cache/repo-health-venv`, or `REPO_HEALTH_VENV`)
from `tools.json`, using `REPO_HEALTH_PYTHON` (≥ 3.11) or `python3`. pip honours `PIP_INDEX_URL`. repowise runs with
`--no-prose` (no model, no key), telemetry off (`DO_NOT_TRACK`, `REPOWISE_TELEMETRY_DISABLED`), and
`--no-editor-setup --no-hook`, so it writes only `.repowise/` and never touches git hooks or editor config.

## Outputs

- `<tool>.raw.*`: the tool's own output.
- `<tool>.findings.json`: `[{ file, line?, rule, message }]`, paths repo-relative. Filter it by changed files for PR mode.
- `summary.json`:

```jsonc
{
  "schemaVersion": 1,
  "sha": "<40-hex HEAD>",
  "generatedAt": "<ISO time>",
  "tools": { "<tool>": { "ok": true, "version": "…", "scope": "…", "durationMs": 0 } },   // ok:false carries error
  "dimensions": {
    "deadCode":     { "total": 0, "files": 0, "exports": 0, "types": 0, "dependencies": 0, "devDependencies": 0, "unlisted": 0, "…": 0 },
    "duplication":  { "clones": 0, "duplicatedLines": 0, "lines": 0, "percent": 0, "files": 0 },
    "deps":         { "violations": 0, "errors": 0, "warnings": 0, "cycles": 0, "modules": 0, "dependencies": 0, "byRule": {} },
    "typeCoverage": { "percent": 0, "typed": 0, "total": 0, "anyCount": 0, "excludedFiles": [] },
    "complexity":   { "functions": 0, "withCoverage": true, "over30": 0, "over8": 0, "maxCrap": 0, "maxComplexity": 0 },
    "churn":        { "filesScored": 0, "hotspotFiles": 0, "commitsRead": 0 },
    "mutation":     { "score": 0, "killed": 0, "survived": 0, "noCoverage": 0, "timeout": 0, "files": [] }
  },
  "hotspots": [ { "file": "…", "fn": "…", "line": 0, "churn": 0, "commits": 0, "crap": 0, "complexity": 0, "coverage": 0, "score": 0 } ]
}
```

`hotspots` is the top 20 functions by `churn × crap`. `churn` is repowise's `churn_percentile` (0–1) for the file,
and `crap` is crapper's score.

`typeCoverage.excludedFiles` lists files that crash TypeScript 6's checker (type-coverage needs the TS 6 API; the repo
itself typechecks with tsgo). They are excluded one at a time and named here.

## CI

Two workflows run these scripts; neither is a required check.

- `.github/workflows/repo-health-pr.yml`, on every PR that changes source files, warn-only. crapper and type-coverage
  look only at the changed files (`--files`); knip, jscpd and dependency-cruiser scan the whole repo. `pr-report.mts`
  keeps the findings in changed files and compares them with the latest weekly scan of dev (the
  `repo-health-reference` artifact): a finding that scan already had is listed as existing, the rest as new, and a
  changed function is flagged when its complexity crosses 10, 20 or 50. Only new findings are counted per rule.
  repowise is not rerun (it indexes the whole history): churn comes from the same weekly scan, so hotspots are weekly
  churn × the complexity of the changed functions. Stryker runs only on a PR labelled `repo-health:mutation`,
  mutating the changed files.
- `.github/workflows/repo-health-weekly.yml`, Mondays and on demand: unit-test coverage, then every tool on the whole
  repo, then `compare.mts` against the previous weekly `summary.json` (downloaded from that run's artifact) and
  `rule-stats.mts` over the past week's PR scans. Reports stay in artifacts; nothing is committed.

```bash
node scripts/checks/repo-health/run.mjs --out <dir> --files a.ts,b.ts --skip repowise,stryker   # what a PR runs
node scripts/checks/repo-health/pr-report.mts --out <dir> --changed-from <base> --reference <weekly dir>
node scripts/checks/repo-health/compare.mts --previous <old summary.json> --current <dir>/summary.json
node scripts/checks/repo-health/rule-stats.mts --dir <dir holding */pr-hits.json>
```
