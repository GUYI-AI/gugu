import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { HtmlPreviewSurface } from '@/components/preview/HtmlPreviewSurface';
import { PREVIEW_LINK_MESSAGE_TYPE, PREVIEW_RESTORED_MESSAGE_TYPE, previewDocumentHtml } from '@shared/preview/preview-link-script';

// A preview shows HTML anyone in the chat wrote: its own script can post the link message the injected script posts.
it('opens a preview link only from a person\'s click in the page, not from the page\'s own script', async () => {
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;height:400px;position:relative';
  document.body.append(container);
  const root = createRoot(container);
  const onLink = vi.fn();
  const forged = '<script>setInterval(function(){ parent.postMessage({ type: ' + JSON.stringify(PREVIEW_LINK_MESSAGE_TYPE) + ', href: "https://forged.example/" }, "*"); }, 50);</script>';
  const url = URL.createObjectURL(new Blob([previewDocumentHtml(
    '<body style="margin:0"><a href="https://clicked.example/" style="display:block;height:100vh">link</a>' + forged + '</body>', true,
  )], { type: 'text/html' }));
  const posted: string[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === PREVIEW_LINK_MESSAGE_TYPE) posted.push(event.data.href);
    if (event.data?.type === PREVIEW_RESTORED_MESSAGE_TYPE) posted.push('restored');
  };
  window.addEventListener('message', onMessage);
  try {
    await act(async () => root.render(<HtmlPreviewSurface fileName="page.html" url={url} onLink={onLink} />));
    await vi.waitFor(() => expect(posted.filter(href => href === 'https://forged.example/').length).toBeGreaterThan(5));
    expect(onLink).not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('iframe')!);
    await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith('https://clicked.example/'));
  } finally {
    act(() => root.unmount()); container.remove(); window.removeEventListener('message', onMessage);
    URL.revokeObjectURL(url);
  }
});
