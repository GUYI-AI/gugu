/** 咕咕写进会话级背景(③)的块都以这几个标签开头(平台块 / 身份块 / 用户规则)。那不是人说的话。 */
const SESSION_CONTEXT_BLOCK = /^\s*<(gugu_platform|agent_identity|user_rules)\b/;
/** One block of that context at the start of a text: a Gugu tag up to its own first closing tag. */
const LEADING_CONTEXT_BLOCK = /^\s*<(gugu_[a-z_]+|agent_identity|user_rules)\b[^>]*>[\s\S]*?<\/\1>/;

export function isSessionContextText(text: string): boolean {
  return SESSION_CONTEXT_BLOCK.test(text);
}

/**
 * What the person said, without the session context Gugu sent in front of it. A harness with no system slot gets that
 * context as user-level blocks of the first prompt, and some records keep them joined with the person's words into one
 * text (Qwen).
 */
export function withoutSessionContext(text: string): string {
  if (!isSessionContextText(text)) return text;
  let rest = text;
  for (let block = LEADING_CONTEXT_BLOCK.exec(rest); block; block = LEADING_CONTEXT_BLOCK.exec(rest)) rest = rest.slice(block[0].length);
  return rest.trimStart();
}
