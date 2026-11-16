/** @jsxImportSource solid-js */
import { BLOCK_REGISTRY } from '@session-chat/components/rows/markdown/block-registry';
import type { StackLayout } from '@session-chat/core/compose';
import type { Measured } from '@session-chat/core/define';
import type { BlockLeafLayout } from '@session-chat/core/layout/layout-types';
import { For, createMemo } from 'solid-js';
import { Dynamic } from 'solid-js/web';

function BlockLeafRender(props: { node: Measured<BlockLeafLayout> }) {
  const def = BLOCK_REGISTRY[props.node.layout.kind];
  if (!def) return null;
  // registry boundary
  return <Dynamic component={def.Render} node={props.node as any} />;
}

export type BlockStackViewProps = {
  node: Measured<StackLayout>;
};

export function BlockStackView(props: BlockStackViewProps) {
  const placed = () => props.node.layout.placed;
  const tops = createMemo(() => new Map(placed().map((p) => [p.child, p.top])));
  // Key by the measured child. Block defs snapshot props.node.layout at mount, so a block whose layout changed must
  // remount — and it does: a grown or re-measured block is a new Measured object. An unchanged block gets the same
  // object back from measureBlockCached, so its row and DOM survive the chunk and only its position follows the stack.
  // A def whose DOM depends on its content only is keyed by its source block instead: a width change re-measures it
  // (new Measured, same block) without a remount, and it reads the current measure through `current`.
  const keyOf = (child: Measured<BlockLeafLayout>): object =>
    BLOCK_REGISTRY[child.layout.kind]?.domFromContentOnly ? child.layout.raw : child;
  const current = createMemo(() => new Map(placed().map((p) => [keyOf(p.child as Measured<BlockLeafLayout>), p.child as Measured<BlockLeafLayout>])));
  return (
    <div style={{ position: 'relative', height: `${props.node.height}px`, width: '100%' }}>
      <For each={placed().map((p) => keyOf(p.child as Measured<BlockLeafLayout>))}>
        {(key) => {
          const child = () => current().get(key)!;
          return (
            <div
              style={{
                position: 'absolute',
                top: `${tops().get(child())}px`,
                left: 0,
                right: 0,
                height: `${child().height}px`,
              }}
            >
              <BlockLeafRender node={child()} />
            </div>
          );
        }}
      </For>
    </div>
  );
}
