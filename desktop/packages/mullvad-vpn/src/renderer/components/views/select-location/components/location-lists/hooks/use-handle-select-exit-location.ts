import React from 'react';

import { RoutePath } from '../../../../../../../shared/routes';
import { useAppContext } from '../../../../../../context';
import { useRelayLocations } from '../../../../../../features/locations/hooks';
import type { AnyLocation } from '../../../../../../features/locations/types';
import { TransitionType, useHistory } from '../../../../../../lib/history';
import { useSelector } from '../../../../../../redux/store';

export function useHandleSelectExitLocation() {
  const { selectExitRelayLocation } = useRelayLocations();
  const history = useHistory();
  const { connectTunnel } = useAppContext();
  const guestMode = useSelector((state) => state.settings.guiSettings.guestMode);
  const loggedIn = useSelector((state) => state.account.status.type === 'ok');

  const handleSelectExitLocation = React.useCallback(
    async (location: AnyLocation | 'any') => {
      // Mullvad locations need a Mullvad account: send guests to log in or add time.
      if (guestMode) {
        history.push(loggedIn ? RoutePath.expired : RoutePath.login);
        return;
      }
      history.push(RoutePath.main, {
        transition: TransitionType.dismiss,
      });
      await selectExitRelayLocation(location === 'any' ? 'any' : location.details);
      await connectTunnel();
    },
    [connectTunnel, guestMode, history, loggedIn, selectExitRelayLocation],
  );

  return handleSelectExitLocation;
}
