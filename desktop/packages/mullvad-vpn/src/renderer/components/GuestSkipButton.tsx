import { useCallback } from 'react';

import { messages } from '../../shared/gettext';
import { RoutePath } from '../../shared/routes';
import { useAppContext } from '../context';
import { Button } from '../lib/components';
import { TransitionType, useHistory } from '../lib/history';

// Continues to the main view without a (paid) account. Only imported VPN configs can be used then.
export function GuestSkipButton() {
  const { setGuestMode } = useAppContext();
  const { reset } = useHistory();

  const skip = useCallback(() => {
    setGuestMode(true);
    reset(RoutePath.main, { transition: TransitionType.push });
  }, [reset, setGuestMode]);

  return (
    <Button variant="secondary" onClick={skip} data-testid="skip-button">
      <Button.Text>
        {
          // TRANSLATORS: Button that lets the user use the app without logging in.
          messages.pgettext('login-view', 'Skip')
        }
      </Button.Text>
    </Button>
  );
}
