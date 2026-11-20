import { hasExpired } from '../../../../shared/account-expiry';
import { useSelector } from '../../../redux/store';

// Mullvad servers can only be used while logged in with time left on the account.
export function useHasSubscription(): boolean {
  const loggedIn = useSelector((state) => state.account.status.type === 'ok');
  const expiry = useSelector((state) => state.account.expiry);
  return loggedIn && expiry !== undefined && !hasExpired(expiry);
}
