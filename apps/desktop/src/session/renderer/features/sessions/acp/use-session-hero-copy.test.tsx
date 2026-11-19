// @vitest-environment jsdom
// #2548 the empty session's hero (mock v33 创建智能体): it asks 「想让新智能体做点什么？」 with a muted line
// 「写一句需求就行，名字和头像会自动生成」 under it, keeping the suggestion chips.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real zh-CN table, so the test reads the words a person sees.
vi.mock('@renderer/localization/use-session-messages', async () => {
  const { zhCNMessages } = await import('@renderer/localization/messages');
  const table = zhCNMessages as Record<string, string>;
  return {
    useSessionMessages: () => ({
      translate: (key: string) => {
        if (table[key] === undefined) throw new Error(`missing ${key}`);
        return table[key];
      },
    }),
  };
});

const { useSessionHeroCopy } = await import('./use-session-hero-copy');
const { ThreadWelcome } = await import('@renderer/lib/ui/assistant-ui/thread-welcome');

const suggestions = [
  { id: 's1', title: '每周五把群里大家的进度整理成周报', prompt: 'weekly' },
  { id: 's2', title: '帮我查三家竞品的定价，做个对比表', prompt: 'pricing' },
];

/** The panel's wiring: the hook's words into the existing ThreadWelcome, chips as before. */
function Hero() {
  const hero = useSessionHeroCopy();
  return <ThreadWelcome title={hero.title} description={hero.description} suggestions={suggestions} onSelectSuggestion={() => {}} />;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const welcome = () => host.querySelector<HTMLElement>('[data-slot="aui-thread-welcome"]')!;
const chips = () => [...host.querySelectorAll('[data-slot="aui-thread-welcome-suggestions"] button')].map((chip) => chip.textContent);

it('asks 想让新智能体做点什么？ with the muted hint under the title, chips kept', async () => {
  await act(async () => root.render(<Hero />));
  expect(welcome().querySelector('h1')?.textContent).toBe('想让新智能体做点什么？');
  const hint = welcome().querySelector('h1 + p');
  expect(hint?.textContent).toBe('写一句需求就行，名字和头像会自动生成');
  expect(hint?.className).toBe('text-sm text-foreground-muted');
  expect(chips()).toEqual(suggestions.map((suggestion) => suggestion.title));
});
