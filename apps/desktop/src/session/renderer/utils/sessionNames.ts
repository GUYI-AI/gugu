export const MAX_SESSION_NAME_LENGTH = 64;

type SessionNameTransformOptions = {
  preserveCapitalization?: boolean;
};

const applyCapitalization = (input: string, options?: SessionNameTransformOptions): string =>
  options?.preserveCapitalization ? input : input.toLowerCase();

export const liveTransformSessionName = (input: string, options?: SessionNameTransformOptions): string =>
  applyCapitalization(input, options)
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, MAX_SESSION_NAME_LENGTH);

export const normalizeSessionName = (input: string, options?: SessionNameTransformOptions): string =>
  applyCapitalization(input, options)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SESSION_NAME_LENGTH);

export const sessionNameCollisionKey = (input: string): string =>
  normalizeSessionName(input).toLowerCase();
