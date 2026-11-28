import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { writeInterface } from '@/lib/viewStateTable';
import { InnerModuleStack } from '@renderer/features/sidebar/inner-sidebar-parts';
import { TopicViewport } from '@renderer/features/sidebar/topic-viewport';
import '@/styles/tokens.css';
import '@renderer/index.css';

const key = 'gugu.taskpage.topicRows';
let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); writeInterface(key, undefined); });

it('restores the chosen row count when the shell fills the topic slot after mount and when a short window grows again', async () => {
  harness = createReactHarness();
  writeInterface(key, 8);
  const render = (rows: number, height: number) => harness.render(
    <div data-region="inner-sidebar" style={{ height, width: 220, display: 'flex', flexDirection: 'column' }}>
      <InnerModuleStack modules={[
        { id: 'topics', node: <section data-inner-sidebar-section="topics">
          <header>Topics</header>
          <TopicViewport all={false} total={14} label="Resize topics">
            <div>{Array.from({ length: rows }, (_, id) => <div key={id} role="listitem" style={{ height: 32 }}>{id}</div>)}</div>
          </TopicViewport>
        </section> },
        { id: 'agents', node: <section data-inner-sidebar-section="agents"><header>Agents</header></section> },
      ]} />
    </div>
  );
  const viewport = () => harness.container.querySelector<HTMLElement>('[data-topic-viewport]')!;
  await render(0, 700);
  await render(14, 700);
  await expect.poll(() => viewport().clientHeight).toBe(8 * 32);
  expect(viewport().scrollHeight).toBe(14 * 32);
  const agents = harness.container.querySelector<HTMLElement>('[data-inner-sidebar-section="agents"]')!;
  const top = agents.getBoundingClientRect().top;
  viewport().scrollTop = viewport().scrollHeight;
  expect(viewport().scrollTop).toBe(6 * 32);
  expect(agents.getBoundingClientRect().top).toBe(top);
  await render(14, 240);
  await expect.poll(() => viewport().clientHeight).toBeLessThan(8 * 32);
  await render(14, 700);
  await expect.poll(() => viewport().clientHeight).toBe(8 * 32);
  const handle = harness.container.querySelector<HTMLElement>('[role=separator]')!;
  await act(async () => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
  expect(viewport().clientHeight).toBe(7 * 32);
});
