import type { Button as ButtonPrimitive } from '@base-ui/react/button';
import type { VariantProps } from 'class-variance-authority';
import { useRef } from 'react';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { Button, type buttonVariants } from './button';
import { BoundShortcut, useCommandAriaShortcut } from './shortcut';

type ConfirmButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function ConfirmButton({ disabled, children, ...props }: ConfirmButtonProps) {
  const key = useCommandAriaShortcut('app.confirm');
  const ref = useRef<HTMLButtonElement>(null);
  // The dialog this button confirms owns the key while focus is inside it, so a dialog over another confirms only itself.
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => {
      const dialog = ref.current?.closest('[role="dialog"]');
      return !dialog || (!!element && dialog.contains(element));
    },
    getCommands: () => [{ id: 'app.confirm', enabled: !disabled, execute: () => { ref.current?.click(); } }],
  });

  return (
    <Button ref={ref} aria-keyshortcuts={key} disabled={disabled} {...props}>
      <span className="flex items-center gap-2">
        {children}
        <BoundShortcut commandId="app.confirm" variant="keycaps" />
      </span>
    </Button>
  );
}
