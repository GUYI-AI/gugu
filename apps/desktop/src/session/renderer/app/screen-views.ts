/** 这几个视图看的是这一屏:会话、项目、对话都是其中一块(gugu-dev#181)。⌘ 点「拼到旁边」也只在这些视图上才有「正看着那块」。 */
const SCREEN_VIEWS: ReadonlySet<string> = new Set(['session', 'project', 'chat', 'screen']);
export function isScreenView(viewId: string | null | undefined): boolean {
  return !!viewId && SCREEN_VIEWS.has(viewId);
}
