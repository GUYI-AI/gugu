import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { importDeviceChoices } from '@renderer/features/session-import/import-device';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

export function useInstalledMachines() {
  const { t } = useTranslation('main');
  useEffect(() => { remoteHostsStore.start(); }, []);
  return importDeviceChoices(t('installedManager.thisComputer'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device).filter(device => !device.isCurrentMachine));
}
