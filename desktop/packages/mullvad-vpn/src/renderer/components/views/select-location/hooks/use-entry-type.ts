import { useHasSubscription } from '../../../../features/account/hooks';
import { useIsUsingMagicMultihop, useMultihop } from '../../../../features/multihop/hooks';

export function useEntryType() {
  const { multihop } = useMultihop();
  const isUsingMagicMultihop = useIsUsingMagicMultihop();
  const hasSubscription = useHasSubscription();

  // Entry relays are Mullvad servers; without a subscription only own configs are offered.
  if (!hasSubscription) {
    return undefined;
  }

  if (multihop === 'always') {
    return 'entry';
  }

  if (isUsingMagicMultihop) {
    return 'entryAutomatic';
  }

  return undefined;
}
