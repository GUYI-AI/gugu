// @vitest-environment jsdom
// Base UI group labels (Menu / Combobox / Select .GroupLabel) throw when rendered outside their group, and the
// throw takes the whole window down to the error page (Base UI error #31 on the project picker). So none of our
// wrappers export a standalone label: a group title is the `label` prop of its group and cannot be placed outside it.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import * as desktopCombobox from '@renderer/lib/ui/combobox';
import * as desktopDropdown from '@renderer/lib/ui/dropdown-menu';
import * as desktopSelect from '@renderer/lib/ui/select';
import { Combobox, DropdownMenu } from '@gugu/session-ui/react/primitives';

it('offers no group label outside a group (type level)', () => {
  // Each line must stay a type error; if one of these parts comes back, the directive itself fails typecheck.
  // @ts-expect-error a menu group title is DropdownMenuGroup's `label`
  void desktopDropdown.DropdownMenuLabel;
  // @ts-expect-error a combobox group title is ComboboxGroup's `label`
  void desktopCombobox.ComboboxLabel;
  // @ts-expect-error a select group title is SelectGroup's `label`
  void desktopSelect.SelectLabel;
  // @ts-expect-error a menu group title is DropdownMenu.Group's `label`
  void DropdownMenu.Label;
  // @ts-expect-error a combobox group title is Combobox.Group's `label`
  void Combobox.Label;
});

it('renders a group label as the title of its own group', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
  try {
    await act(async () => root.render(
      <desktopDropdown.DropdownMenu defaultOpen>
        <desktopDropdown.DropdownMenuTrigger>Open</desktopDropdown.DropdownMenuTrigger>
        <desktopDropdown.DropdownMenuContent>
          <desktopDropdown.DropdownMenuGroup label="Folders">
            <desktopDropdown.DropdownMenuItem>One</desktopDropdown.DropdownMenuItem>
          </desktopDropdown.DropdownMenuGroup>
          <desktopDropdown.DropdownMenuGroup>
            <desktopDropdown.DropdownMenuItem>Untitled</desktopDropdown.DropdownMenuItem>
          </desktopDropdown.DropdownMenuGroup>
        </desktopDropdown.DropdownMenuContent>
      </desktopDropdown.DropdownMenu>,
    ));
    expect(errors).toEqual([]);
    const groups = [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-group"]')];
    expect(groups).toHaveLength(2);
    const label = groups[0]!.querySelector<HTMLElement>('[data-slot="dropdown-menu-label"]');
    expect(label?.textContent).toBe('Folders');
    expect(groups[0]!.getAttribute('aria-labelledby')).toBe(label!.id);
    expect(groups[1]!.querySelector('[data-slot="dropdown-menu-label"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
