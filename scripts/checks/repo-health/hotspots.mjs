// Hotspot = how often a file changes (repowise churn) × how risky a function in it is (crapper CRAP).
// churn is repowise's churn_percentile for the file (0–1, ranked by decayed commit activity); a function's
// score is churn × CRAP (CC when no coverage was measured). Files repowise did not index score 0.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// From the raw outputs in <out>, so crapper and repowise may run in separate invocations. [] until both exist.
export function hotspotsFrom(out, count) {
  const crapFile = resolve(out, 'crapper.raw.jsonl')
  const churnFile = resolve(out, 'repowise.raw.json')
  if (!existsSync(crapFile) || !existsSync(churnFile)) return []
  const functions = readFileSync(crapFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .filter((fn) => fn.language === 'typescript' || fn.language === 'javascript')
  const churn = new Map(JSON.parse(readFileSync(churnFile, 'utf8')).map((row) => [row.file, row]))
  return hotspots(functions, churn, count)
}

function hotspots(functions, churnByFile, count) {
  return functions
    .map((fn) => {
      const churn = churnByFile.get(fn.path)
      const crap = fn.crap ?? fn.complexity
      return {
        file: fn.path,
        fn: fn.name,
        line: fn.line,
        churn: churn?.percentile ?? 0,
        commits: churn?.commits ?? 0,
        crap,
        complexity: fn.complexity,
        coverage: fn.coverage,
        score: Number(((churn?.percentile ?? 0) * crap).toFixed(2)),
      }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.crap - a.crap)
    .slice(0, count)
}
