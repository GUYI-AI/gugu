import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Layout changes keep the mounted ProseMirror view, DOM selection and IME session intact. */
export function usePhoneComposer(mobile: boolean, root: RefObject<HTMLDivElement | null>) {
  const [expanded, setExpanded] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const expandedRef = useRef(false);

  useLayoutEffect(() => {
    if (!mobile) return;
    const node = root.current;
    const editor = node?.querySelector<HTMLElement>('[contenteditable]');
    if (!node || !editor) return;
    const measure = () => {
      // Do not infer wrapping from character count: mentions, CJK and rotation all change it.
      const line = Number.parseFloat(getComputedStyle(editor).lineHeight);
      setMultiline(editor.getBoundingClientRect().height > line + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [mobile, root]);

  useLayoutEffect(() => {
    if (!mobile || !expanded) return;
    const node = root.current;
    if (!node) return;
    const viewport = window.visualViewport;
    const measure = () => {
      node.style.setProperty('--phone-editor-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      node.style.setProperty('--phone-editor-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      node.style.setProperty('--phone-editor-viewport-left', `${viewport?.offsetLeft ?? 0}px`);
      node.style.setProperty('--phone-editor-viewport-width', `${viewport?.width ?? window.innerWidth}px`);
    };
    measure();
    viewport?.addEventListener('resize', measure);
    viewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    return () => {
      viewport?.removeEventListener('resize', measure);
      viewport?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      for (const edge of ['top', 'height', 'left', 'width']) node.style.removeProperty(`--phone-editor-viewport-${edge}`);
    };
  }, [mobile, expanded, root]);

  const collapse = () => {
    expandedRef.current = false;
    setExpanded(false);
    root.current?.style.removeProperty('min-height');
  };
  const toggle = () => {
    if (expandedRef.current) { collapse(); return; }
    const node = root.current;
    if (node) node.style.minHeight = `${node.getBoundingClientRect().height}px`;
    expandedRef.current = true;
    setExpanded(true);
  };
  return { expanded: mobile && expanded, multiline: mobile && multiline, toggle, collapse };
}
