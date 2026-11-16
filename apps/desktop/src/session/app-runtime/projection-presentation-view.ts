import type { ProjectionPresentation } from '@shared/extensions/projection-presentation';

/** A passive layer on the existing picture node; it never handles input or opens another watch. */
export function installProjectionPresentation(surface: HTMLElement) {
  const layer = document.createElement('div');
  layer.dataset.projectionPresentation = '';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
  const target = document.createElement('div'), action = document.createElement('div'), cursor = document.createElement('div');
  target.dataset.projectionTarget = ''; action.dataset.projectionAction = ''; cursor.dataset.projectionCursor = '';
  const caption = 'position:absolute;max-width:calc(100% - 16px);padding:3px 7px;border-radius:4px;background:rgba(0,0,0,.65);color:white;font:12px/1.4 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  target.style.cssText = `${caption};top:8px;left:8px`;
  action.style.cssText = `${caption};bottom:8px;left:8px`;
  cursor.style.cssText = 'position:absolute;width:16px;height:20px;filter:drop-shadow(0 1px 1px #0008);transform:translate(-2px,-1px)';
  // An inert local shape, never App-provided SVG or HTML.
  cursor.innerHTML = '<svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true"><path d="M2 1v15l4-4 3 6 3-1-3-6h6Z" fill="white" stroke="#222" stroke-width="1.5"/></svg>';
  layer.append(target, action, cursor); surface.append(layer);
  let current: ProjectionPresentation | null = null, clicked = '';
  const render = () => {
    layer.hidden = !current;
    if (!current) return;
    target.hidden = !current.targetLabel;
    target.textContent = current.targetLabel ?? '';
    action.hidden = !current.action;
    action.textContent = current.action?.label ?? '';
    if (current.action) action.dataset.phase = current.action.phase; else delete action.dataset.phase;
    cursor.hidden = !current.cursor;
    if (!current.cursor) return;
    const { width, height } = current.frame, box = surface.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height);
    cursor.style.left = `${(box.width - width * scale) / 2 + current.cursor.x * scale}px`;
    cursor.style.top = `${(box.height - height * scale) / 2 + current.cursor.y * scale}px`;
    if (current.cursor.click && current.cursor.click !== clicked) {
      clicked = current.cursor.click;
      cursor.animate([{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], { duration: 220 });
    }
  };
  const observer = new ResizeObserver(render); observer.observe(surface); render();
  return { update(value: ProjectionPresentation | null) { current = value; render(); }, close() { observer.disconnect(); layer.remove(); } };
}
