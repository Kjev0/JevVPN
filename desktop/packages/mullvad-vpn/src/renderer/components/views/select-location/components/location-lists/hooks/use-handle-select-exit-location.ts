import React from 'react';

import { RoutePath } from '../../../../../../../shared/routes';
import { useAppContext } from '../../../../../../context';
import { useHasSubscription } from '../../../../../../features/account/hooks';
import { useRelayLocations } from '../../../../../../features/locations/hooks';
import type { AnyLocation } from '../../../../../../features/locations/types';
import { TransitionType, useHistory } from '../../../../../../lib/history';
import { useSelector } from '../../../../../../redux/store';

export function useHandleSelectExitLocation() {
  const { selectExitRelayLocation } = useRelayLocations();
  const history = useHistory();
  const { connectTunnel, setActiveCustomVpnConfig } = useAppContext();
  const hasSubscription = useHasSubscription();
  const loggedIn = useSelector((state) => state.account.status.type === 'ok');

  const handleSelectExitLocation = React.useCallback(
    async (location: AnyLocation | 'any') => {
      // Mullvad locations need a subscription: send the user to log in or add time.
      if (!hasSubscription) {
        history.push(loggedIn ? RoutePath.expired : RoutePath.login);
        return;
      }
      history.push(RoutePath.main, {
        transition: TransitionType.dismiss,
      });
      // Own configs and Mullvad servers are exclusive, and an active config takes precedence.
      await setActiveCustomVpnConfig(undefined);
      await selectExitRelayLocation(location === 'any' ? 'any' : location.details);
      await connectTunnel();
    },
    [
      connectTunnel,
      hasSubscription,
      history,
      loggedIn,
      selectExitRelayLocation,
      setActiveCustomVpnConfig,
    ],
  );

  return handleSelectExitLocation;
}
