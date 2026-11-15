/**
 * @@@focus-modality — 焦点环只跟键盘导航走(@@@focus-visible-7333 的补全)。
 *
 * Chromium 把「元素已聚焦时的任何一次按键」都当成键盘交互:鼠标点了一个按钮、再单按一下 Shift(截图快捷键 Win+Shift+S、
 * ⌘⇧4 就是这样),它就开始匹配 :focus-visible,画出键盘焦点环(11-10 owner 截图里「Added by you」的蓝框,父提交实测复现)。
 *
 * 这里记一个全局的输入模态:按下指针 ⇒ 指针模态;按下一个导航键(不是修饰键、也没按着 Ctrl / ⌘ / Alt 的组合 —— 那是快捷键)
 * ⇒ 键盘模态。指针模态期间,**持有焦点的那个元素**带 `data-pointer-focus`。焦点样式统一写成
 * `:focus-visible:not([data-pointer-focus])`(Tailwind 的 `focus-visible:` 变体在 tailwind.css 里改成同一个选择器),
 * 于是 Tab、方向键、Enter、Space 照常出环,单按修饰键、快捷键不出。
 *
 * @@@mark-on-the-focused-element — 标记只挂在焦点元素自己身上,❌ 挂根元素。会因它变样子的只有焦点元素一个;挂在 <html> 上、
 * 选择器写成 `:not([data-pointer-focus] *)` 时,Blink 认不出该重算谁,每次鼠标 ↔ 键盘切换都把整份文档重算一遍
 * (8.8k 节点的页面一次 12.7k 元素,随页面大小线性涨)。
 */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol'])

export const POINTER_FOCUS_ATTRIBUTE = 'data-pointer-focus'

/** 这次按键算不算键盘导航:修饰键本身、按着 Ctrl / ⌘ / Alt 的组合都不算;Shift+Tab 算。 */
export function isNavigationKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  return !MODIFIER_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function installFocusModality(doc: Document): void {
  let pointer = false
  const mark = (target: EventTarget | null, on: boolean) => {
    // <body> holds focus when nothing does: it has no focus style, so it never carries the mark.
    if (target instanceof Element && target !== doc.body && target !== doc.documentElement) target.toggleAttribute(POINTER_FOCUS_ATTRIBUTE, on)
  }
  // capture:先于组件自己的处理(Tab 的默认焦点移动在 keydown 之后发生,新焦点出来时已是键盘模态)。
  doc.addEventListener('pointerdown', () => { pointer = true; mark(doc.activeElement, true) }, true)
  doc.addEventListener('keydown', (event) => {
    if (!isNavigationKey(event)) return
    pointer = false
    mark(doc.activeElement, false)
  }, true)
  doc.addEventListener('focusin', (event) => mark(event.target, pointer), true)
  doc.addEventListener('focusout', (event) => mark(event.target, false), true)
}

if (typeof document !== 'undefined') installFocusModality(document)
