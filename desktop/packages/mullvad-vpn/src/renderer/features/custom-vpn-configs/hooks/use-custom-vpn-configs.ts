import React from 'react';

import type { ICustomVpnConfig } from '../../../../shared/custom-vpn-config';
import { useAppContext } from '../../../context';

// Imported configs kept up to date with the main process, or undefined until loaded.
export function useCustomVpnConfigs(): ICustomVpnConfig[] | undefined {
  const { getCustomVpnConfigs, listenCustomVpnConfigs } = useAppContext();
  const [configs, setConfigs] = React.useState<ICustomVpnConfig[]>();

  React.useEffect(() => {
    let mounted = true;
    const unsubscribe = listenCustomVpnConfigs(setConfigs);
    void getCustomVpnConfigs().then((configs) => mounted && setConfigs(configs));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [getCustomVpnConfigs, listenCustomVpnConfigs]);

  return configs;
}

export function useActiveWireguardConfig(): ICustomVpnConfig | undefined {
  return useCustomVpnConfigs()?.find((config) => config.active && config.protocol === 'wireguard');
}
