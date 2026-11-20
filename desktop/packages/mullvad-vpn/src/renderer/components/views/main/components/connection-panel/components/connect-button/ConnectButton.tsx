import { useCallback } from 'react';

import { messages } from '../../../../../../../../shared/gettext';
import log from '../../../../../../../../shared/logging';
import { RoutePath } from '../../../../../../../../shared/routes';
import { useAppContext } from '../../../../../../../context';
import { useHasSubscription } from '../../../../../../../features/account/hooks';
import { useActiveWireguardConfig } from '../../../../../../../features/custom-vpn-configs/hooks';
import { Button, ButtonProps } from '../../../../../../../lib/components';
import { useHistory } from '../../../../../../../lib/history';

export function ConnectButton(props: ButtonProps) {
  const { connectTunnel } = useAppContext();
  const { push } = useHistory();
  const hasSubscription = useHasSubscription();
  const activeConfig = useActiveWireguardConfig();

  const onConnect = useCallback(async () => {
    try {
      // Without a subscription only own WireGuard configs can be used, never Mullvad servers.
      if (!hasSubscription && !activeConfig) {
        push(RoutePath.customVpnConfigs);
        return;
      }
      await connectTunnel();
    } catch (e) {
      const error = e as Error;
      log.error(`Failed to connect the tunnel: ${error.message}`);
    }
  }, [activeConfig, connectTunnel, hasSubscription, push]);

  return (
    <Button color="success" onClick={onConnect} {...props}>
      <Button.Text>{messages.pgettext('tunnel-control', 'Connect')}</Button.Text>
    </Button>
  );
}
