/** `@[label](target)`, the shape `stringifyMention` writes (a target with spaces sits in angle brackets). */
const MENTION = /@\[([^\]\n]+)\]\((<[^>\n]+>|[^)\s]+)\)/g;
const ABSOLUTE_PATH = /^<?(?:\/|[A-Za-z]:[\\/])/;

/** Reply headers never show a path from this computer: a mention of one reads as its label, where it stands. */
export function conversationQuoteText(text: string): string {
  return text.replace(MENTION, (whole, label: string, target: string) => ABSOLUTE_PATH.test(target) ? label : whole);
}
