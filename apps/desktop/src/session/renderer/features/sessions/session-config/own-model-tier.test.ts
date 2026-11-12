import { describe, expect, it } from 'vitest';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';
import { ownModelTierOptions } from './own-model-tier';

/**
 * #2507 一把 API Key 连接的会话:活会话报的清单里,连接的模型照探针目录那份名字叫 —— 只叫模型名。
 * pi / opencode 的活清单把它叫成「提供方/模型」,提供方就是这把连接。
 */
const LIVE = {
  'opencode/big-pickle': { name: 'OpenCode Zen/Big Pickle' },
  'api-key-connection/user-model': { name: '我的 Key/user-model', description: 'd' },
  'api-key-connection/second-model': { name: '我的 Key/second-model' },
};

function catalog(extra: Partial<Extract<HarnessCatalogState, { kind: 'ready' }>> = {}): HarnessCatalogState {
  return {
    kind: 'ready',
    models: [
      { id: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
      { id: 'api-key-connection/user-model', name: 'user-model' },
      { id: 'api-key-connection/second-model', name: 'second-model' },
    ],
    selected: 'api-key-connection/user-model',
    efforts: [],
    selectedEffort: null,
    ...extra,
  };
}

describe('own tier in a live session on an API key connection', () => {
  it('every connection model (same ids as the catalog recorded) shows its model name; everything else as the live session reported', () => {
    const connectionModels = ['api-key-connection/user-model', 'api-key-connection/second-model'];
    expect(ownModelTierOptions({ route: 'own', live: LIVE, catalog: catalog({ connectionModels }) })).toEqual({
      'opencode/big-pickle': { name: 'OpenCode Zen/Big Pickle' },
      'api-key-connection/user-model': { name: 'user-model', description: 'd' },
      // 第二个也只叫模型名(chip 照这个名字):从前只改了起步那一个,另一个读成「我的 Key/second-model」。
      'api-key-connection/second-model': { name: 'second-model' },
    });
  });

  it('a catalog not read on a connection: the live list itself, untouched', () => {
    for (const state of [catalog(), { kind: 'unknown' } as const]) {
      expect(ownModelTierOptions({ route: 'own', live: LIVE, catalog: state })).toBe(LIVE);
    }
  });

  it('the live session does not list that id (another connection was selected since): untouched', () => {
    const live = { 'Pi 1/user-model': { name: 'Pi 1/user-model' } };
    expect(ownModelTierOptions({ route: 'own', live, catalog: catalog({ connectionModels: ['api-key-connection/user-model'] }) })).toBe(live);
  });
});
