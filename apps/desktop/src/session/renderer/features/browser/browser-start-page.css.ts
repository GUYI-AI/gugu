import { style } from '@vanilla-extract/css';
import { SESSION_CHAT_FONT_STACK } from '@renderer/lib/chat/font-stack';

export const startPage = style({
  height: '100%', boxSizing: 'border-box', overflow: 'auto', padding: '32px 24px',
  background: 'color-mix(in srgb, var(--background) 98%, var(--foreground))', fontFamily: SESSION_CHAT_FONT_STACK.sans.join(', '),
  containerType: 'inline-size',
});
export const content = style({ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 40 });
