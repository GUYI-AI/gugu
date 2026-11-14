import { buildPromptInjectionPayload } from '@shared/prompt-injection';

export { buildPromptInjectionPayload } from '@shared/prompt-injection';

type SendInput = (data: string) => Promise<unknown>;

type InjectPromptArgs = {
  text: string;
  forceBracketedPaste?: boolean;
  sendInput: SendInput;
};

export async function pastePromptInjection(args: InjectPromptArgs): Promise<void> {
  const payload = buildPromptInjectionPayload({
    text: args.text,
    forceBracketedPaste: args.forceBracketedPaste,
  });
  if (!payload) return;
  await args.sendInput(payload);
}
