/** @jsxImportSource solid-js */
import { render } from 'solid-js/web';
import { afterEach, expect, it } from 'vitest';
import { UserMessageEditor } from '../components/rows/message/UserMessageEditor';

const NOTICE = 'Sending removes everything after this message.';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); });

function mount(width: number, notice?: string) {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  document.body.append(host);
  dispose = render(() => <UserMessageEditor height={260} textHeight={48} edit={{
    itemId: 'a', text: 'Hello', pending: false, canSubmit: true, notice, onChange: () => {}, onCancel: () => {}, onSubmit: () => {},
  }} />, host);
  return host.querySelector<HTMLElement>('[data-user-message-editor]')!;
}

it('says what sending will remove, on its own line above the buttons, even in a narrow editor', () => {
  const editor = mount(236, NOTICE);
  const text = [...editor.querySelectorAll('div')].find(element => element.textContent === NOTICE)!;
  const buttons = editor.querySelector('button')!.getBoundingClientRect();
  const box = text.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(150);
  expect(box.bottom).toBeLessThanOrEqual(buttons.top);
});

it('says nothing when sending removes nothing', () => {
  expect(mount(600).textContent).not.toContain('Sending removes');
});
