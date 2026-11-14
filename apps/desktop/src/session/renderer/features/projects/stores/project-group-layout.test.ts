import { describe, expect, it } from 'vitest';
import { groupRowOrder, type GroupLayoutProject } from './project-group-layout';

// 由谁画合并那一行:桌面侧栏、手机「伙伴」与派任务那张卡同一条(groupRowOrder)。每一档单独验。
describe('groupRowOrder', () => {
  const order = (...rows: GroupLayoutProject[]) => [...rows].sort(groupRowOrder).map((row) => row.id);

  it('1. this computer first, even offline-looking and newest', () => {
    expect(order(
      { id: 'a', machine: 'd22', online: true, createdAt: '2026-01-01' },
      { id: 'z', machine: null, online: false, createdAt: '2026-12-31' },
    )).toEqual(['z', 'a']);
  });

  it('2. then a machine that is connected now, even if created later', () => {
    expect(order(
      { id: 'a', machine: 'old', online: false, createdAt: '2026-01-01' },
      { id: 'z', machine: 'new', online: true, createdAt: '2026-12-31' },
    )).toEqual(['z', 'a']);
  });

  it('3. then the one created first; an unknown creation time goes last', () => {
    expect(order(
      { id: 'a', machine: 'd1', online: true, createdAt: '2026-06-01' },
      { id: 'z', machine: 'd2', online: true, createdAt: '2026-01-01' },
      { id: 'm', machine: 'd3', online: true },
    )).toEqual(['z', 'a', 'm']);
  });

  it('4. then the id, so the same rows always give the same answer', () => {
    expect(order(
      { id: 'b', machine: 'd1', online: true, createdAt: '2026-01-01' },
      { id: 'a', machine: 'd2', online: true, createdAt: '2026-01-01' },
    )).toEqual(['a', 'b']);
  });
});
