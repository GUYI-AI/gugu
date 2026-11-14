/** Temporarily let a fixed phone editor use the visual viewport without moving its DOM node. */
export function releasePhoneEditorContainingBlocks(root: HTMLElement): () => void {
  const restored: Array<() => void> = [];
  const viewportValues: Record<string, string> = {
    'container-type': 'normal', contain: 'none', transform: 'none',
    translate: 'none', rotate: 'none', scale: 'none', perspective: 'none',
    filter: 'none', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none',
    'content-visibility': 'visible', 'will-change': 'auto',
  };
  for (let node: HTMLElement | null = root; node; node = node.parentElement) {
    const element = node;
    const computed = getComputedStyle(element);
    for (const [name, value] of Object.entries(viewportValues)) {
      const current = computed.getPropertyValue(name);
      if (!current || current === value) continue;
      const previous = element.style.getPropertyValue(name);
      const priority = element.style.getPropertyPriority(name);
      element.style.setProperty(name, value, 'important');
      restored.push(() => {
        if (previous) element.style.setProperty(name, previous, priority);
        else element.style.removeProperty(name);
      });
    }
  }
  return () => { for (const restore of restored.reverse()) restore(); };
}
