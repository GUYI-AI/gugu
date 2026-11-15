/**
 * 咕咕自己开的子窗口(spec session-page「一屏几块」:一整块、一个 App 单独成窗):`window.open('about:blank', 名字)`
 * 的名字带这个前缀,主进程认这个前缀放行、配窗口外观;别的 window.open 照旧交给系统浏览器。
 */
export const AUX_WINDOW_NAME_PREFIX = 'gugu-aux:';

/** 构建角标也要浮在原生网页视图之上,不参与宿主文档里的网页遮挡判定。 */
export const BUILD_TAG_WINDOW_NAME = `${AUX_WINDOW_NAME_PREFIX}build-tag`;

/**
 * 每次开角标那层都换一个名字:界面整页重载后再开时 ❌ 撞上旧的同名那层 —— Chromium 会直接把旧的交回来
 * (不经过主进程),旧内容还在里面。
 */
export function buildTagWindowName(): string {
  return `${BUILD_TAG_WINDOW_NAME}:${crypto.randomUUID()}`;
}

export function isBuildTagWindowName(frameName: string): boolean {
  return frameName.startsWith(`${BUILD_TAG_WINDOW_NAME}:`);
}

export function isAuxWindowRequest(url: string, frameName: string): boolean {
  return (url === 'about:blank' || url === '') && frameName.startsWith(AUX_WINDOW_NAME_PREFIX);
}

