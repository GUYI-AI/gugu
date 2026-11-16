import { OWNER_PROFILE_MEMORY_FILE } from './assistantPolicy';
/** 文件开头 `---` 之间那几行里的简单键值(name / description / type,也认 metadata 下缩进的 type)。 */
export function readFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const opening = /^---[ \t]*\n/.exec(normalized);
  if (!opening) return { fields: {}, body: normalized.trim() };
  const offset = opening[0].length;
  const close = /^---[ \t]*(?:\n|$)/m.exec(normalized.slice(offset));
  if (!close) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of normalized.slice(offset, offset + close.index).split('\n')) {
    const match = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    const scalar = raw.trim().replace(/^((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'))[ \t]+#.*$/, '$1').replace(/^(?!["'])(.*?)[ \t]+#.*$/, '$1');
    const value = scalar.replace(/^(['"])(.*)\1$/, (_, quote: string, body: string) => quote === "'" ? body.replace(/''/g, "'") : decodeDoubleQuotedScalar(body));
    if (value && !(key in fields)) fields[key] = value;
  }
  return { fields, body: normalized.slice(offset + close.index + close[0].length).trim() };
}

function decodeDoubleQuotedScalar(body: string): string {
  try { return JSON.parse('"' + body + '"') as string; }
  catch { return body.replace(/\\([\\"])/g, '$1'); }
}

/** Claude Code 的记忆分四种;「关于你 / 关于助理」对应前两种。 */
export type MemoryKind = 'user' | 'feedback' | 'project' | 'reference' | 'other';

export type MemoryNote = {
  file: string;
  title: string;
  description: string;
  kind: MemoryKind;
  body: string;
};

/**
 * 开通时写进记忆夹的那一条(owner-profile.md)。文件里叫「关于主人」,那是写给助理自己读的名字;
 * 界面上对人一律叫「关于你」(owner 10-26:「我叫主人别人可能不叫主人」),❌ 把「主人」「用户」原样摆给人看。
 */
export function isOwnerProfileNote(note: { file: string }): boolean {
  return note.file === OWNER_PROFILE_MEMORY_FILE;
}

/** 代码围栏内的示例不是记忆标题或索引条目。 */
function visibleMemoryLines(text: string): string[] {
  let fence: { marker: string; length: number } | null = null;
  return text.split('\n').map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (match) { fence = { marker: match[1][0], length: match[1].length }; return ''; }
    return line;
  });
}

const MEMORY_KINDS: readonly MemoryKind[] = ['user', 'feedback', 'project', 'reference'];
const memoryKind = (value: string | undefined): MemoryKind | undefined => {
  const aliases: Record<string, MemoryKind> = { 用户: 'user', 关于主人: 'user', 偏好: 'user', 反馈: 'feedback', 关于助理: 'feedback', 项目: 'project', 参考: 'reference', 资料: 'reference' };
  return MEMORY_KINDS.find(kind => kind === value?.toLowerCase())
    ?? (value !== undefined && Object.hasOwn(aliases, value) ? aliases[value] : undefined);
};

/** Legacy memories often put their readable name/category in the index instead of YAML. */
export function memoryIndexHints(index: string): Map<string, { title: string; kind?: MemoryKind }> {
  const result = new Map<string, { title: string; kind?: MemoryKind }>();
  let kind: MemoryKind | undefined;
  for (const line of visibleMemoryLines(index)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) kind = memoryKind(heading[1].trim());
    const references = line.replace(/(`+)(?!`)([\s\S]*?)\1(?!`)/g, '');
    for (const link of references.matchAll(/\[([^\]]+)\]\((?:<([^<>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)/gi)) {
      let destination: string;
      try { destination = decodeURIComponent(link[2] ?? link[3]).replace(/^\.\//, ''); } catch { continue; }
      if (/\.md$/i.test(destination) && !destination.includes('/')) result.set(destination, { title: link[1], ...(kind ? { kind } : {}) });
    }
  }
  return result;
}

export function parseMemoryNote(file: string, text: string, hint?: { title: string; kind?: MemoryKind }): MemoryNote {
  const { fields, body } = readFrontmatter(text);
  // Missing metadata is a reference, not an invented claim about the person.
  const kind = memoryKind(fields.type) ?? memoryKind(fields.category) ?? hint?.kind ?? 'reference';
  const heading = /^#{1,6}\s+(.+?)\s*$/m.exec(visibleMemoryLines(body).join('\n'))?.[1];
  const filename = file.replace(/\.md$/i, '');
  return {
    file,
    title: fields.title || fields.name || heading || hint?.title || (/\p{Script=Han}/u.test(filename) ? filename : '记忆'),
    description: fields.description ?? '',
    kind,
    body,
  };
}

/** 删一条记忆时把索引里指向它的那一行一起拿掉(否则 MEMORY.md 里留一条指向空处的链接)。 */
export function removeIndexEntry(index: string, file: string): string {
  const visible = visibleMemoryLines(index);
  return index.split('\n').filter((_, line) => !memoryIndexHints(visible[line]).has(file)).join('\n');
}

