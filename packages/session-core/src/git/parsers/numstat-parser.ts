export type Numstat = Map<string, { additions: number; deletions: number }>

export function parseNumstat(stdout: string): Numstat {
  const map: Numstat = new Map()
  const nul = stdout.includes('\0')
  const records = nul ? stdout.split('\0') : stdout.trim().split('\n')
  for (let i = 0; i < records.length; i++) {
    const line = records[i]
    if (!line) continue
    const [addStr, delStr, ...pathParts] = line.split('\t')
    let filePath = pathParts.join('\t')
    if (nul && pathParts.length === 1 && pathParts[0] === '') {
      i += 2
      filePath = records[i]
    }
    if (!filePath) continue
    const current = map.get(filePath) ?? { additions: 0, deletions: 0 }
    current.additions += addStr === '-' ? 0 : Number.parseInt(addStr ?? '0', 10) || 0
    current.deletions += delStr === '-' ? 0 : Number.parseInt(delStr ?? '0', 10) || 0
    map.set(filePath, current)
  }
  return map
}
