import { useId, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowUp, ChevronLeft, Monitor } from '@/lib/icons';
import { followLink } from '@/lib/guguLinks';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localizedManifestText } from '@shared/extensions/catalog';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { AppSettingsForm } from './app-settings-form';
import { installedExtensionsStore } from './installed-extensions-store';
import { openApp } from './app-dock';
import './panel/app-store.css';
import './app-settings-page.css';

type Tab = 'overview' | 'settings';

/**
 * Resident host page of an App without a page of its own (#7289). Overview = what to ask an agent; Settings = what its author
 * declared. Everything else about the App (permissions, which agents get it, switching off, uninstalling) is on its settings
 * page, one link away.
 */
export const AppSettingsPage = observer(function AppSettingsPage({ manifest, active }: { manifest: ExtensionManifest; active: boolean }) {
  const { translate: t, locale } = useSessionMessages();
  const { navigate } = useNavigate();
  const prefix = useId();
  const text = localizedManifestText(manifest, locale);
  const icon = installedExtensionsStore.appIcons[manifest.id];
  const main = installedExtensionsStore.mainTabOf(manifest.id);
  const fields = manifest.settings ?? [];
  const tabs = [...(text.examples.length > 0 ? ['overview' as const] : []), ...(fields.length > 0 ? ['settings' as const] : [])];
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'overview');
  /** Same as 「对 agent 说」 on the App page: a new task with this sentence already in its box. */
  const ask = (example: string) => {
    composerDrafts.set(NEW_SESSION_DRAFT_KEY, example);
    navigate('new-session');
  };

  return <main className="tool-app-page" aria-label={text.name}>
    <div className="tool-app-content">
      {main && !main.hostSettings ? <button type="button" className="mk-back" data-testid="app-settings-back" onClick={() => openApp(manifest.id)}>
        <ChevronLeft className="size-3.5" />{t('common.back')}
      </button> : null}
      <header className="tool-app-header">
        {icon ? <img className="tool-app-icon" src={icon} alt="" /> : <Monitor className="tool-app-icon text-foreground-muted" />}
        <div className="tool-app-heading">
          <div className="tool-app-title"><h1>{text.name}</h1><span>v{manifest.version}</span></div>
          {text.subtitle ? <p>{text.subtitle}</p> : null}
        </div>
        <button type="button" className="mk-link" data-testid="app-settings-manage" onClick={() => void followLink({ kind: 'app-detail', extensionId: manifest.id })}>{t('extensions.allSettings')}</button>
      </header>
      {tabs.length > 1 ? <div className="tool-app-tabs" role="tablist" aria-label={text.name}>
        {tabs.map(name => <button key={name} type="button" role="tab" id={`${prefix}-${name}-tab`} aria-selected={tab === name}
          aria-controls={`${prefix}-${name}`} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
          onKeyDown={event => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const next = tabs[(tabs.indexOf(name) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            setTab(next);
            document.getElementById(`${prefix}-${next}-tab`)?.focus();
          }}>{t(`appSettings.${name}`)}</button>)}
      </div> : null}

      {tabs.includes('overview') ? <section id={`${prefix}-overview`} role={tabs.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={tabs.length > 1 ? `${prefix}-overview-tab` : undefined} hidden={tab !== 'overview'}>
        <h2>{t('extensions.askAgent')}</h2>
        <div className="mk-asks">
          {text.examples.map(example => <button type="button" className="mk-ask" key={example} title={t('extensions.askAgentHint')} onClick={() => ask(example)}>
            <span>{example}</span>
            <ArrowUp className="size-3.5" />
          </button>)}
        </div>
      </section> : null}

      {tabs.includes('settings') ? <AppSettingsForm manifest={manifest} active={active} id={`${prefix}-settings`} role={tabs.length > 1 ? 'tabpanel' : undefined}
        labelledBy={tabs.length > 1 ? `${prefix}-settings-tab` : undefined} hidden={tab !== 'settings'}
        read={() => rpc.extensions.openSettings({ extensionId: manifest.id })}
        save={(settings) => rpc.extensions.setSettings({ extensionId: manifest.id, settings })} /> : null}
    </div>
  </main>;
});
