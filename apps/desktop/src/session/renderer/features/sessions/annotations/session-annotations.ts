import { action, makeAutoObservable, observable } from 'mobx';
import type { SupportedLocale } from '@gugu/session-shared/format';
import { enUSAnnotationMessages, zhCNAnnotationMessages } from '../../../localization/messages-annotations';
import { annotationConversationKey, type AnnotationConversation } from '@shared/browser-annotation';
import type { TurnAnnotation } from '@gugu/session-core/acp/client';

export type AnnotationRect = { x: number; y: number; width: number; height: number };
export type BrowserAnnotationSelection = {
  kind: 'browser';
  browserId: string;
  url: string;
  filePath?: string;
  selector: string | null;
  targetPath: string | null;
  elementTag?: string;
  rect: AnnotationRect;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  text: string;
  annotation: string;
  /** The actual page capture, with this selection's number drawn on it. */
  screenshot: File;
};
export type DiffAnnotationSelection = {
  kind: 'diff';
  path: string;
  turnId: string;
  patchIndex: number;
  rowIndex: number;
  oldLine?: number;
  newLine?: number;
  text: string;
  annotation: string;
};
type AnnotationSelection = BrowserAnnotationSelection | DiffAnnotationSelection;
type AnnotationIdentity = { id: string; number: number };
export type SessionAnnotation = AnnotationSelection & AnnotationIdentity;

/** One conversation's unsent feedback; independent of the tab's annotation mode. */
export class SessionAnnotations {
  items: readonly SessionAnnotation[] = [];
  private nextNumber = 1;
  submissionVersion = 0;
  private senders: readonly (() => void)[] = [];
  private removers: readonly ((id: string) => void)[] = [];

  constructor() {
    makeAutoObservable(this, { items: observable.ref }, { autoBind: true });
  }

  reserveNumber(): number { return this.nextNumber++; }

  add<T extends AnnotationSelection>(selection: T, number = this.reserveNumber()): T & AnnotationIdentity {
    const item = { ...selection, id: crypto.randomUUID(), number };
    this.items = [...this.items, item];
    return item;
  }

  get nextAnnotationNumber(): number { return this.nextNumber; }

  update(id: string, annotation: string): void {
    this.items = this.items.map(item => item.id === id ? { ...item, annotation } : item);
  }

  remove(id: string): void {
    if (!this.items.some(item => item.id === id)) return;
    this.items = this.items.filter(item => item.id !== id);
    for (const remove of this.removers) remove(id);
  }

  clear(): void {
    const removed = this.items;
    this.items = [];
    for (const item of removed) for (const remove of this.removers) remove(item.id);
  }

  bindRemove(remove: (id: string) => void): () => void {
    this.removers = [...this.removers, remove];
    return action(() => { this.removers = this.removers.filter(current => current !== remove); });
  }

  /** Identity matters: an edit or addition made while Send waits is still a draft. */
  submitted(snapshot: readonly SessionAnnotation[]): void {
    this.items = this.items.filter(item => !snapshot.includes(item));
    this.submissionVersion++;
    if (!this.items.length) this.nextNumber = 1;
  }

  bindSend(sender: () => void): () => void {
    this.senders = [...this.senders, sender];
    return action(() => { this.senders = this.senders.filter(current => current !== sender); });
  }

  get canSend(): boolean { return this.senders.length > 0 && this.items.length > 0; }
  send(): void { this.senders.at(-1)?.(); }
}

const drafts = new Map<string, SessionAnnotations>();
export const sessionAnnotations = {
  forConversation(conversation: AnnotationConversation, accountId?: string | null): SessionAnnotations {
    const identity = annotationConversationKey(conversation);
    const key = conversation.kind === 'chat' ? JSON.stringify([accountId ?? null, identity]) : identity;
    let draft = drafts.get(key);
    if (!draft) { draft = new SessionAnnotations(); drafts.set(key, draft); }
    return draft;
  },
  forSession(sessionId: string): SessionAnnotations {
    return this.forConversation({ kind: 'session', sessionId });
  },
};

/** What a comment points at, as the composer and the sent message's card both name it. */
export function annotationPlace(item: AnnotationSelection): string {
  return item.kind === 'browser' ? item.filePath ?? item.url : item.path;
}

type PromptKey = Extract<keyof typeof enUSAnnotationMessages, `annotations.prompt.${string}`>;
function promptCopy(locale: SupportedLocale) {
  const messages = locale === 'zh-CN' ? zhCNAnnotationMessages : enUSAnnotationMessages;
  // Only trusted coordinates and reference numbers enter templates. Page evidence stays JSON-escaped below.
  return (key: PromptKey, values: Readonly<Record<string, number>> = {}): string =>
    messages[key].replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

/**
 * The comments as they go with the person's words: each one's card (`target`, `comment`) and the agent's text for it.
 * Localized section names; page evidence never becomes an instruction. A comment that opens a section carries its
 * heading, so the agent's texts joined by a blank line read as one sectioned list.
 */
export function promptAnnotations(items: readonly SessionAnnotation[], locale: SupportedLocale = 'en-US'): TurnAnnotation[] {
  const copy = promptCopy(locale);
  let previousHeading: PromptKey | undefined;
  return items.map(item => {
    const heading: PromptKey = item.kind === 'diff' || item.filePath ? 'annotations.prompt.allComments' : 'annotations.prompt.browserComments';
    const entry = item.kind === 'diff' ? [
      copy('annotations.prompt.userComment', { number: item.number }),
      copy('annotations.prompt.diff'),
      `${copy('annotations.prompt.filePath')} ${JSON.stringify(item.path)}`,
      copy('annotations.prompt.patch', { patch: item.patchIndex + 1 }),
      ...(item.oldLine === undefined ? [] : [copy('annotations.prompt.oldLine', { line: item.oldLine })]),
      ...(item.newLine === undefined ? [] : [copy('annotations.prompt.newLine', { line: item.newLine })]),
      copy('annotations.prompt.sourceEvidence'),
      ...item.text.split(/\r?\n/).map(line => `> ${line}`),
      '',
      copy('annotations.prompt.comment'), item.annotation,
    ].join('\n') : [
      copy(item.filePath ? 'annotations.prompt.userComment' : 'annotations.prompt.browserComment', { number: item.number }),
      copy(item.filePath ? 'annotations.prompt.html' : 'annotations.prompt.browser'),
      copy('annotations.prompt.position', { x: item.rect.x, y: item.rect.y, width: item.viewport.width, height: item.viewport.height }),
      copy('annotations.prompt.untrusted'),
      `${copy(item.filePath ? 'annotations.prompt.filePath' : 'annotations.prompt.pageUrl')} ${JSON.stringify(item.filePath ?? item.url)}`, copy('annotations.prompt.frame'), `${copy('annotations.prompt.target')} ${JSON.stringify(item.text)}`,
      `${copy('annotations.prompt.selector')} ${JSON.stringify(item.selector ?? copy('annotations.prompt.regionTarget'))}`, `${copy('annotations.prompt.targetPath')} ${JSON.stringify(item.targetPath ?? copy('annotations.prompt.regionTarget'))}`,
      ...(!item.selector ? [copy('annotations.prompt.region', { ...item.rect, number: item.number })] : []),
      `${copy('annotations.prompt.screenshot')} ${item.screenshot.name}${copy('annotations.prompt.screenshotAttachment', { number: item.number })}`,
      copy('annotations.prompt.comment'), item.annotation,
    ].join('\n');
    const promptText = previousHeading === heading ? entry : `${copy(heading)}\n\n${entry}`;
    previousHeading = heading;
    return { number: item.number, target: annotationPlace(item), comment: item.annotation, promptText };
  });
}

/** One send's words and comments: the words are what the person typed, the comments travel beside them. */
export type AnnotatedSend = { text: string; annotations?: TurnAnnotation[] };
export function annotatedSend(prompt: string, items: readonly SessionAnnotation[], locale: SupportedLocale = 'en-US'): AnnotatedSend {
  return { text: prompt.trim(), ...(items.length ? { annotations: promptAnnotations(items, locale) } : {}) };
}

/** Group chat (until its messages carry comments beside the words): the comments and the request folded into one text. */
export function annotationPrompt(prompt: string, items: readonly SessionAnnotation[], locale: SupportedLocale = 'en-US'): string {
  if (!items.length) return prompt.trim();
  const sections = promptAnnotations(items, locale).map(annotation => annotation.promptText);
  if (prompt.trim()) sections.push(`${promptCopy(locale)('annotations.prompt.request')}\n${prompt.trim()}`);
  return sections.join('\n\n');
}
