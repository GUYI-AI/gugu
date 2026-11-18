/**
 * #7274 页签里的网页是画在界面**之上**的独立 view(browser-page-views.ts):咕咕自己的菜单、弹窗、提示、拖拽落点
 * 压到网页那一块上时,z-index 再高也盖不住它。所以页签每隔一会儿看一眼「网页那一块上面有没有别的东西」,
 * 有就报 `occluded`:网页收起、占位换成一张截图,浮层照常画在上面。同 VS Code 内置浏览器的做法。
 *
 * 两种看法,缺一不可:
 * - **采样**:在那一块上撒一张网格,每个点问 `elementFromPoint` 最上面是谁 —— 不是占位自己就是被盖住了。
 *   能看见界面里一切点得着的东西(起始页、加载失败页、远端提问卡片、菜单、弹窗…),不必一个个登记。
 * - **按选择器量**:点不着的(`pointer-events: none` 的提示、toast 外框、拖拽落点预览)采样看不见,
 *   按它们的标记量一遍外框。
 * 拖拽进行中(页签 / 分栏 / 文件,`data-gugu-dragging`)一律让开:落点提示就画在网页那一块上。
 */

export type PageRect = { left: number; top: number; width: number; height: number };

/** 点不着、采样看不见的那几类浮层(Base UI 的弹层内容、toast、看图、拖拽落点预览),外加显式登记的。 */
export const PAGE_OCCLUDER_SELECTOR = [
  ...[
    'dropdown-menu-content',
    'dropdown-menu-sub-content',
    'popover-content',
    'select-content',
    'combobox-content',
    'tooltip-content',
    'preview-card-content',
    'dialog-overlay',
    'dialog-content',
    'sheet-overlay',
    'sheet-content',
  ].map((slot) => `[data-slot="${slot}"]`),
  '[role="tooltip"]',
  '[data-sonner-toast]',
  '.pswp',
  '[data-pane-edge-preview]',
  '[data-block-drop-preview]',
  '[data-occludes-browser-page]',
].join(', ');

/** 选择器里用到的属性:它们在已有元素上被打上 / 改掉,那个元素也要进集合。 */
const OCCLUDER_ATTRIBUTES = ['data-slot', 'role', 'data-sonner-toast', 'data-occludes-browser-page', 'data-pane-edge-preview', 'data-block-drop-preview'];

/**
 * @@@occluder-set 文档里此刻带浮层标记的元素。❌ 每次检测都按选择器扫整个文档:页签每帧(跟随移动)和每 250ms 都要问一次,
 * 长对话挂着十万级节点时一次扫描就是几十毫秒,开着 App 页签的长私聊连空闲都在扫。这里只在第一次扫一遍,之后由
 * MutationObserver 只看新加进来的子树、被改了标记的元素;拆掉的、不再匹配的在用到时剔掉。代价跟 DOM 的变化量走,不跟文档大小走。
 */
const occluderSets = new WeakMap<Document, Set<Element>>();
function trackedOccluders(doc: Document): Element[] {
  let set = occluderSets.get(doc);
  if (!set) {
    const tracked = new Set<Element>(doc.querySelectorAll(PAGE_OCCLUDER_SELECTOR));
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if ((record.target as Element).matches(PAGE_OCCLUDER_SELECTOR)) tracked.add(record.target as Element);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as Element;
          if (element.matches(PAGE_OCCLUDER_SELECTOR)) tracked.add(element);
          for (const inner of element.querySelectorAll(PAGE_OCCLUDER_SELECTOR)) tracked.add(inner);
        }
      }
    }).observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: OCCLUDER_ATTRIBUTES });
    occluderSets.set(doc, tracked);
    set = tracked;
  }
  for (const element of set) if (!element.isConnected || !element.matches(PAGE_OCCLUDER_SELECTOR)) set.delete(element);
  return [...set];
}

/** 分栏拖动条(见 isBrowserPageOccluded 的采样那段)。 */
const RESIZE_HANDLE_SELECTOR = '[role="separator"]';

/** 网页那一块上撒的采样点:内部 cols × rows 的网格,外加四个角(各往里收 `inset`,避开边线上的分隔条)。 */
export function occlusionSamplePoints(rect: PageRect, cols = 5, rows = 4, inset = 3): Array<[number, number]> {
  if (rect.width <= inset * 2 || rect.height <= inset * 2) return [];
  const points: Array<[number, number]> = [];
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      points.push([rect.left + (rect.width * (col + 0.5)) / cols, rect.top + (rect.height * (row + 0.5)) / rows]);
    }
  }
  const right = rect.left + rect.width - inset;
  const bottom = rect.top + rect.height - inset;
  points.push([rect.left + inset, rect.top + inset], [right, rect.top + inset], [rect.left + inset, bottom], [right, bottom]);
  return points;
}

export function rectsOverlap(a: PageRect, b: { left: number; top: number; right: number; bottom: number }): boolean {
  return b.right > a.left && b.left < a.left + a.width && b.bottom > a.top && b.top < a.top + a.height;
}

/** 网页那一块此刻被界面里的什么东西盖着(见文件头)。`placeholder` 是页签里那块占位。 */
export function isBrowserPageOccluded(placeholder: HTMLElement, rect: PageRect): boolean {
  const doc = placeholder.ownerDocument;
  if (doc.documentElement.hasAttribute('data-gugu-dragging')) return true;
  for (const [x, y] of occlusionSamplePoints(rect)) {
    const top = doc.elementFromPoint(x, y);
    // 圆角/裁切边缘的命中会退回到外层容器;装着网页的祖先不是盖住网页的浮层。
    if (!top || top === placeholder || placeholder.contains(top) || top.contains(placeholder)) continue;
    // 分栏的拖动条:看得见的只是边上一根线,两侧各伸出几像素看不见的「好抓」区,伸进网页那一块不算盖着。
    if (top.closest(RESIZE_HANDLE_SELECTOR)) continue;
    return true;
  }
  for (const element of trackedOccluders(doc)) {
    // 自己里面的、以及把自己装在里面的(页签所在的那一层)都不算盖着。
    if (placeholder.contains(element) || element.contains(placeholder)) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || !rectsOverlap(rect, box)) continue;
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    return true;
  }
  return false;
}
