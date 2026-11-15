import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { releasePhoneEditorContainingBlocks } from './phone-editor-viewport';

/** Layout changes keep the mounted ProseMirror view, DOM selection and IME session intact. */
export function usePhoneComposer(mobile: boolean, root: RefObject<HTMLDivElement | null>) {
  const [expanded, setExpanded] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [hasText, setHasText] = useState(false);
  const expandedRef = useRef(false);

  useLayoutEffect(() => {
    if (!mobile) {
      expandedRef.current = false;
      setExpanded(false);
      root.current?.style.removeProperty('min-height');
      return;
    }
    const node = root.current;
    const editor = node?.querySelector<HTMLElement>('[contenteditable]');
    if (!node || !editor) return;
    let composing = false;
    const measure = () => {
      if (composing) return;
      const text = !!editor.textContent?.trim();
      const line = Number.parseFloat(getComputedStyle(editor).lineHeight);
      // The expanded editor itself fills the panel. Its paragraph boxes describe the actual text lines.
      const boxes = Array.from(editor.children).map((child) => child.getBoundingClientRect()).filter((box) => box.height > 0);
      const height = boxes.length ? Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top)) : editor.getBoundingClientRect().height;
      setHasText(text);
      setMultiline(text && height > line + 1);
    };
    const start = () => { composing = true; };
    const end = () => { composing = false; queueMicrotask(measure); };
    measure();
    const observer = new ResizeObserver(measure);
    const content = new MutationObserver(measure);
    observer.observe(editor);
    content.observe(editor, { childList: true, subtree: true, characterData: true });
    editor.addEventListener('input', measure);
    editor.addEventListener('compositionstart', start);
    editor.addEventListener('compositionend', end);
    return () => {
      observer.disconnect(); content.disconnect();
      editor.removeEventListener('input', measure);
      editor.removeEventListener('compositionstart', start);
      editor.removeEventListener('compositionend', end);
    };
  // Recheck after reclaiming the empty attachment gutter, before paint, so a width change cannot flash a wrong line state.
  }, [mobile, root, hasText]);

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

  useLayoutEffect(() => {
    if (!mobile || !expanded || !root.current) return;
    return releasePhoneEditorContainingBlocks(root.current);
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
  return { expanded: mobile && expanded, multiline: mobile && multiline, hasText: mobile && hasText, toggle, collapse };
}
