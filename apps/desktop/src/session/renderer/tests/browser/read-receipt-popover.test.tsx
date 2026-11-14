import { createElement, Fragment } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerContactsCatalog';
import '@/styles/tokens.css';

const { ReadReceiptPopover } = await import('@/components/ReadReceiptPopover');
const { Popover } = await import('@/components/ui/Popover');

type Member = { id: string; displayName: string; avatar: null; isAgent: boolean; agentStatus?: AgentDisplayStatus; undelivered?: boolean };
const member = (i: number, agentStatus?: AgentDisplayStatus): Member => ({ id: `m${i}`, displayName: `成员 ${i}`, avatar: null, isAgent: !!agentStatus, agentStatus });
const range = (from: number, n: number) => Array.from({ length: n }, (_, k) => member(from + k));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(900, 700);
  harness = createReactHarness();
});
afterEach(() => harness.cleanup());

const panel = () => document.querySelector<HTMLElement>('[data-testid="receipt"]');
const heads = () => [...panel()!.querySelectorAll('[data-slot="section-label"]')].map((h) => h.textContent);
const names = () => [...panel()!.querySelectorAll('.gg-list-row-title')].map((n) => n.textContent);
const scroller = () => panel()!.firstElementChild as HTMLElement;

async function open(readers: Member[], unreaders: Member[]) {
  const handle = Popover.createHandle<string>();
  await renderWithAppProviders(harness, createElement(Fragment, null,
    createElement(Popover.Trigger, { handle, payload: 'msg-1', render: createElement('button', { 'data-testid': 'ring', style: { margin: 40 } }) }),
    createElement(ReadReceiptPopover, { handle, receiptOf: () => ({ readers, unreaders }), testId: 'receipt' })));
  document.querySelector<HTMLElement>('[data-testid="ring"]')!.click();
  await until('receipt list painted', () => !!panel() && names().length > 0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { nodes: panel()!.querySelectorAll('*').length };
}

describe('read receipt list', () => {
  it('is one column: read above unread, card as wide as its names', async () => {
    await open([member(1), member(2), { ...member(3), displayName: '测试号与票务（P4 分流） 2' }], range(4, 2));
    expect(heads()).toEqual(['已读3', '未读2']);
    expect(names()).toEqual(['成员 1', '成员 2', '测试号与票务（P4 分流） 2', '成员 4', '成员 5']);
    const width = panel()!.getBoundingClientRect().width;
    expect(width).toBeGreaterThanOrEqual(200);
    expect(width).toBeLessThanOrEqual(320);
    // 名字不截断:最长那位的标题没有溢出。
    for (const title of panel()!.querySelectorAll<HTMLElement>('.gg-list-row-title')) expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth);
  });

  it('shows one 全部已读 section when nobody is left unread', async () => {
    await open([member(1)], []);
    expect(heads()).toEqual(['全部已读']);
    expect(names()).toEqual(['成员 1']);
  });

  it('puts online agents first among the unread, keeping the rest in order', async () => {
    await open([member(1)], [member(2), member(3, 'offline'), member(4, 'working'), member(5), member(6, 'idle')]);
    expect(names()).toEqual(['成员 1', '成员 4', '成员 6', '成员 2', '成员 5', '成员 3']);
  });

  it('says on its own row which agent the message never reached', async () => {
    await open([member(1)], [{ ...member(2, 'offline'), undelivered: true }, member(3)]);
    const rows = [...panel()!.querySelectorAll('.gg-list-row')].map((row) => row.textContent);
    expect(rows).toEqual(['成员 1', '成员 3', '成员 2所在实例未运行、未送达']);
  });

  it('opens a 2000-member receipt with the nodes of a 200-member one, both groups in view', async () => {
    const mid = await open(range(1, 100), range(101, 100));
    harness.cleanup(); harness = createReactHarness();
    const big = await open(range(1, 1000), range(1001, 1000));
    expect(big.nodes).toBe(mid.nodes);
    // 每组先 20 位,其余收进「还有 N 位」:滚到底就看到未读那组的开头。
    const more = () => [...panel()!.querySelectorAll('button')].map((b) => b.textContent);
    scroller().scrollTop = 1e6;
    await until('collapsed unread head in view', () => more().includes('还有 980 位') && names().includes('成员 1020'));
    expect(more()).toEqual(['还有 980 位']);
    expect(heads().at(-1)).toBe('未读1000');

    // 展开以后还是只挂一窗;滚到底,吸在顶上的是「未读」。
    panel()!.querySelector<HTMLButtonElement>('button')!.click();
    await until('unread group expanded', () => !more().includes('还有 980 位'));
    scroller().scrollTop = 1e6;
    await until('last unread member mounted', () => names().includes('成员 2000'));
    expect(panel()!.querySelectorAll('.gg-list-row').length).toBeLessThan(30);
    const top = scroller().getBoundingClientRect().top;
    const stuck = [...panel()!.querySelectorAll<HTMLElement>('[data-slot="section-label"]')].find((h) => Math.abs(h.getBoundingClientRect().top - top) < 1);
    expect(stuck?.textContent).toBe('未读1000');
  });
});
