/**
 * Inline image: a picture placed at a point of the text (paste, drop or the attach button), t3code-style.
 *
 * An atom inline node `{ id, src, name }`. `id` is the host's attachment id: the bytes, upload and preview stay with the
 * host's attachment list, the node only says where in the words the picture goes. It serializes in place as
 * `![image](gugu-attachment:<id>)` (`inlineImageMarker`), so the one text the host reads carries the order; the host
 * turns each marker into what its conversation sends (`inlineImageParts`).
 */

import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { InlineImagePill } from '../inline-image-pill';
import { inlineImageMarker } from '../serialize';

export const INLINE_IMAGE_NODE = 'inlineImage';

export const InlineImage = Node.create({
  name: INLINE_IMAGE_NODE,
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return { id: { default: null }, src: { default: null }, name: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'span[data-inline-image]' }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-inline-image': node.attrs.id as string }, inlineImageMarker(node.attrs.id as string)];
  },
  renderText({ node }) {
    return inlineImageMarker(node.attrs.id as string);
  },
  addNodeView() {
    return ReactNodeViewRenderer(InlineImagePill, { as: 'span' });
  },
});
