import type { ComponentProps } from 'react';
import { BrowserToolbar } from '@renderer/features/browser/browser-toolbar';
import { cn } from '@/lib/cn';
import './phone-browser-toolbar.css';

/** The phone projection owns its touch geometry; the task renderer stays desktop-only. */
export function PhoneBrowserToolbar({ className, ...props }: ComponentProps<typeof BrowserToolbar>) {
  return <BrowserToolbar {...props} className={cn('phone-browser-toolbar', className)} />;
}
