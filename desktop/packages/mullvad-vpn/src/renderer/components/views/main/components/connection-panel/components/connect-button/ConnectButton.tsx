import { useCallback } from 'react';

import { messages } from '../../../../../../../../shared/gettext';
import log from '../../../../../../../../shared/logging';
import { RoutePath } from '../../../../../../../../shared/routes';
import { useAppContext } from '../../../../../../../context';
import { Button, ButtonProps } from '../../../../../../../lib/components';
import { useHistory } from '../../../../../../../lib/history';
import { useSelector } from '../../../../../../../redux/store';

export function ConnectButton(props: ButtonProps) {
  const { connectTunnel, getCustomVpnConfigs } = useAppContext();
  const { push } = useHistory();
  const guestMode = useSelector((state) => state.settings.guiSettings.guestMode);

  const onConnect = useCallback(async () => {
    try {
      // Guests can only use their own WireGuard configs; Mullvad servers need an account.
      if (
        guestMode &&
        !(await getCustomVpnConfigs()).some((c) => c.active && c.protocol === 'wireguard')
      ) {
        push(RoutePath.customVpnConfigs);
        return;
      }
      await connectTunnel();
    } catch (e) {
      const error = e as Error;
      log.error(`Failed to connect the tunnel: ${error.message}`);
    }
  }, [connectTunnel, getCustomVpnConfigs, guestMode, push]);

  return (
    <Button color="success" onClick={onConnect} {...props}>
      <Button.Text>{messages.pgettext('tunnel-control', 'Connect')}</Button.Text>
    </Button>
  );
}
