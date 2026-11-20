import { useCallback } from 'react';

import { messages } from '../../../../shared/gettext';
import { RoutePath } from '../../../../shared/routes';
import { IconButton, IconButtonProps, MainHeader } from '../../../lib/components';
import { TransitionType, useHistory } from '../../../lib/history';
import { useSelector } from '../../../redux/store';

export type MainHeaderBarAccountButtonProps = Omit<IconButtonProps, 'icon'>;

export const AppMainHeaderBarAccountButton = (props: MainHeaderBarAccountButtonProps) => {
  const history = useHistory();
  const openAccount = useCallback(
    () => history.push(RoutePath.account, { transition: TransitionType.show }),
    [history],
  );

  // Guests have no account page, so the button leads to the login view instead.
  const openLogin = useCallback(
    () => history.push(RoutePath.login, { transition: TransitionType.show }),
    [history],
  );

  const loggedIn = useSelector((state) => state.account.status.type === 'ok');
  const guestMode = useSelector((state) => state.settings.guiSettings.guestMode);
  if (!loggedIn && !guestMode) {
    return null;
  }

  return (
    <MainHeader.IconButton
      onClick={loggedIn ? openAccount : openLogin}
      data-testid="account-button"
      aria-label={messages.gettext('Account settings')}
      {...props}>
      <IconButton.Icon icon="account-circle" />
    </MainHeader.IconButton>
  );
};
