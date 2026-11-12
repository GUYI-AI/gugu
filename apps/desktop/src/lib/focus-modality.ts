/**
 * @@@focus-modality — 焦点环只跟键盘导航走(@@@focus-visible-7333 的补全)。
 *
 * Chromium 把「元素已聚焦时的任何一次按键」都当成键盘交互:鼠标点了一个按钮、再单按一下 Shift(截图快捷键 Win+Shift+S、
 * ⌘⇧4 就是这样),它就开始匹配 :focus-visible,画出键盘焦点环(11-10 owner 截图里「Added by you」的蓝框,父提交实测复现)。
 *
 * 这里记一个全局的输入模态:按下指针 ⇒ 根元素带 `data-pointer-focus`;按下一个导航键(不是修饰键、也没按着 Ctrl / ⌘ / Alt
 * 的组合 —— 那是快捷键)⇒ 去掉。焦点样式统一写成 `:focus-visible:not([data-pointer-focus] *)`(Tailwind 的 `focus-visible:`
 * 变体在 tailwind.css 里改成同一个选择器),于是 Tab、方向键、Enter、Space 照常出环,单按修饰键、快捷键不出。
 */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol'])

export const POINTER_FOCUS_ATTRIBUTE = 'data-pointer-focus'

/** 这次按键算不算键盘导航:修饰键本身、按着 Ctrl / ⌘ / Alt 的组合都不算;Shift+Tab 算。 */
export function isNavigationKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return !MODIFIER_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function installFocusModality(doc: Document): void {
  const root = doc.documentElement
  // capture:先于组件自己的处理(Tab 的默认焦点移动在 keydown 之后发生,新焦点出来时标记已经去掉)。
  doc.addEventListener('pointerdown', () => root.setAttribute(POINTER_FOCUS_ATTRIBUTE, ''), true)
  doc.addEventListener('keydown', (event) => {
    if (isNavigationKey(event)) root.removeAttribute(POINTER_FOCUS_ATTRIBUTE)
  }, true)
}

if (typeof document !== 'undefined') installFocusModality(document)
