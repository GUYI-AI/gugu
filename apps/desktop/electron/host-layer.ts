import { BrowserWindow, type IpcMain } from 'electron'
import { HOST_LAYER_SHOW } from '@shared/aux-window'
import { openWindowLayer, WINDOW_LAYER_RANK, type WindowLayerContent } from './window-layers'

const layers = new WeakMap<BrowserWindow, { webContents: WindowLayerContent['webContents']; show: (shown: boolean) => void }>()

/**
 * @@@host-layer — 宿主画、却要浮在原生网页视图(内置浏览器的 WebContentsView)之上的浮层画在这一层。网页不收起、
 * 不换截图,所以没有「换」的那一下(Windows 上换截图会露出一两帧占位底色,见 browser-page-occlusion.ts 那条路)。
 *
 * 契约(界面那边的入口是 src/components/HostLayer.tsx 的 useHostLayer,两边只此一处):
 * - 谁开:主窗界面第一次要用时 window.open 开一层(名字见 @shared/aux-window),之后一直复用;一扇窗只一层,
 *   界面整页重载后再开会换掉旧的。层由主进程关:主窗重载、换页、渲染进程没了、窗口关了(window-layers.ts)。
 * - 什么时候露出来:界面经 HOST_LAYER_SHOW 明说。露出来时盖满整个窗口内容区,为的是「点外面」也落在层里,
 *   由浮层自己判定为外部点击而关闭;这一下不会穿透到底下的网页或界面。❌ 拿层文档的 preferred size 当开关:
 *   收起的视图不再排版,下一次「要露出来」永远报不上来(Linux 真机实测,0×0 同样如此)。
 * - 焦点:露出来时键盘焦点在层里(方向键、回车、Esc 由浮层处理);收起时交回主窗界面。
 * - 坐标:层贴在窗口内容区左上角,和主窗界面同一套 DIP 坐标;跟着窗口一起移动、缩放、换显示器(同一扇窗,同一个缩放系数)。
 * - 窗口失焦(切到别的程序):由界面那边看层文档的 blur 自行关闭。
 */
export function openHostLayer(parent: BrowserWindow, content: WindowLayerContent): void {
  const { webContents } = content
  const previous = layers.get(parent)?.webContents
  if (previous && !previous.isDestroyed()) previous.close()
  let shown = false
  const view = openWindowLayer(parent, content, WINDOW_LAYER_RANK.hostLayer, { focusTarget: () => (shown ? webContents : null) })
  const cover = () => {
    if (parent.isDestroyed() || webContents.isDestroyed()) return
    const [width, height] = parent.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  const show = (next: boolean) => {
    if (next === shown || webContents.isDestroyed()) return
    shown = next
    cover()
    view.setVisible(shown)
    if (shown) webContents.focus()
    else if (!parent.isDestroyed()) parent.webContents.focus()
  }
  layers.set(parent, { webContents, show })
  parent.on('resize', cover)
  webContents.once('destroyed', () => {
    parent.removeListener('resize', cover)
    if (layers.get(parent)?.webContents === webContents) layers.delete(parent)
  })
}

export function registerHostLayer(ipc: IpcMain): void {
  ipc.handle(HOST_LAYER_SHOW, (event, shown: unknown) => {
    // The layer is opened by the same window's window.open, which returns only after openHostLayer ran.
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent) layers.get(parent)?.show(shown === true)
  })
}
