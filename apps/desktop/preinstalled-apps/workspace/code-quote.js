/** Lines of code quoted as they are: fenced, so indentation and marks stay, the fence longer than any backtick run inside. */
export function codeQuote(text) {
  const body = text.replace(/\s+$/, '')
  const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((run) => run.length + 1)))
  return [fence, ...body.split('\n'), fence].map((line) => `> ${line}`).join('\n')
}
