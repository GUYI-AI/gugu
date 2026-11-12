import { describe, expect, it } from 'vitest';
import { findHomeProject } from './machine-home';

describe('别的机器的主目录那一行(#609 起只剩个人助理那台,#7199)', () => {
  it('已有同路径的项目就是主目录项目(末尾斜杠不算差别)', () => {
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }, { id: 'h', path: '/home/alice/' }], '/home/alice')?.id).toBe('h');
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }], '/home/alice')).toBeNull();
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }], null)).toBeNull();
  });
});
