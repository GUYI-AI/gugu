import { describe, expect, it } from 'vitest';
import { conversationLink, widgetLink } from '@gugu/core/shared/ui/guguLink';
import { MARKDOWN_SANITIZE_SCHEMA, messageReferenceBlocks, messageReferencePreview, normalizeMarkdownSource } from './dialect';

const chat = '7359ec7b-fd9d-4dd2-93b6-81e9464fe017';
const message = '96b0f029-c181-4b1e-bb55-a2db0d1d0100';
const messageHref = conversationLink(chat, message);
const widgetHref = widgetLink('legacy:Widget/界 #1');

describe('message reference paragraphs', () => {
  it('previews only the four real blocks, with labels supplied by the viewing caller', () => {
    const source = `intro\n\n${messageHref}\n\n${widgetHref}\n\n\`${widgetHref}\`\n\n${widgetLink('private')}\n\n${messageHref}\n\n${widgetLink('fifth')}`;
    expect(messageReferencePreview(messageReferenceBlocks(source), target => target.kind === 'widget' && target.widgetId === 'legacy:Widget/界 #1' ? 'Build results' : undefined, { quote: '[引用]', message: '[引用消息]' }))
      .toBe(`intro\n\n[引用消息]\n\n[引用] Build results\n\n\`${widgetHref}\`\n\n[引用]\n\n[引用消息]\n\n${widgetLink('fifth')}`);
  });
  it('expands a generated bare link when its text id contains Markdown punctuation', () => {
    const widgetId = "*a* _b_ ~~c~~ (d) !'";
    const href = widgetLink(widgetId);
    expect(messageReferenceBlocks(href).blocks.map(block => block.target)).toEqual([{ kind: 'widget', widgetId }]);
  });
  it('reads bare and autolink references through the shared link parser', () => {
    const source = `intro\n\n${messageHref}\n\n<${widgetHref}>\n\nend`;
    const result = messageReferenceBlocks(source);
    expect(result.blocks.map(block => block.target)).toEqual([
      { kind: 'message', chatId: chat, messageId: message },
      { kind: 'widget', widgetId: 'legacy:Widget/界 #1' },
    ]);
    expect(result.blocks.map(block => result.content.slice(block.start, block.end))).toEqual([messageHref, `<${widgetHref}>`]);
  });
  it.each([
    `- ${widgetHref}`, `> ${widgetHref}`, `# ${widgetHref}`, `\`${widgetHref}\``,
    `\`\`\`\n${widgetHref}\n\`\`\``, `    ${widgetHref}`, `![widget](${widgetHref})`,
    `[widget](${widgetHref})`, `${widgetHref} more text`, `${widgetHref} ${messageHref}`,
    `| Reference |\n|---|\n| ${widgetHref} |`, conversationLink(chat),
    `gugu://chat/${chat}/message/${message}`,
  ])('keeps nested, decorated, partial and other references in the Markdown: %s', source => {
    expect(messageReferenceBlocks(source).blocks).toEqual([]);
  });
  it('uses one source-ordered limit for message and widget blocks, leaving later links in the content', () => {
    const hrefs = [messageHref, widgetHref, widgetLink('second'), messageHref, widgetLink('fifth')];
    const source = hrefs.join('\n\n');
    const result = messageReferenceBlocks(source);
    expect(result.blocks.map(block => block.href)).toEqual(hrefs.slice(0, 4));
    expect(result.content).toBe(source);
    expect(result.content.slice(result.blocks[3]!.end)).toContain(hrefs[4]);
  });
  it('returns offsets in the same normalized source that callers render', () => {
    const source = `\\[x^2\\]\n\n  <${widgetHref}>  \n\n${messageHref}`;
    const result = messageReferenceBlocks(source);
    expect(result.content).toBe(normalizeMarkdownSource(source));
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map(block => result.content.slice(block.start, block.end).trim())).toEqual([`<${widgetHref}>`, messageHref]);
    expect(MARKDOWN_SANITIZE_SCHEMA.protocols.href).toContain('gugu-widget');
  });
});
