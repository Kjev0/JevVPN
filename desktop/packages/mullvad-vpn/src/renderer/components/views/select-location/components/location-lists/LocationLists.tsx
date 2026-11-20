import React from 'react';

import { useRecents } from '../../../../../features/locations/hooks';
import { LocationType } from '../../../../../features/locations/types';
import { FlexColumn } from '../../../../../lib/components/flex-column';
import { useEffectEvent } from '../../../../../lib/utility-hooks';
import { useScrollPositionContext } from '../../ScrollPositionContext';
import { CountryLocations } from '../country-locations';
import { CustomListLocations } from '../custom-list-locations';
import { NoSearchResult } from '../no-search-result';
import { OwnConfigLocations, useOwnConfigs } from '../own-config-locations';
import { RecentLocations } from '../recent-locations';
import { useHasCustomLists, useHasSearched, useHasSearchedLocations } from './hooks';
import { LocationListsProvider, useLocationListsContext } from './LocationListsContext';

export type LocationsListsProps = {
  type: LocationType;
};

function LocationsListsImpl() {
  const { hasRecents } = useRecents();

  const hasSearched = useHasSearched();
  const hasVisibleCustomLists = useHasCustomLists();
  const hasSearchedLocations = useHasSearchedLocations();
  const { type } = useLocationListsContext();
  const ownConfigs = useOwnConfigs();

  // Imported configs only apply to the exit (single-hop) tunnel.
  const showOwnConfigs =
    type === 'exit' && ownConfigs !== undefined && (!hasSearched || ownConfigs.length > 0);

  const showRecentLocations = !hasSearched && hasRecents;
  const showCustomListLocationLists = !hasSearched || hasVisibleCustomLists;
  const showCountryLocations = !hasSearched || hasSearchedLocations;

  const { resetScroll } = useScrollPositionContext();
  const resetScrollEffectEvent = useEffectEvent(() => resetScroll());

  React.useEffect(() => {
    resetScrollEffectEvent();
  }, []);

  const hasNoSearchResult =
    hasSearched &&
    !showOwnConfigs &&
    !showCustomListLocationLists &&
    !showCountryLocations &&
    !showRecentLocations;
  if (hasNoSearchResult) {
    return <NoSearchResult />;
  }

  return (
    <FlexColumn gap="large">
      {showOwnConfigs && <OwnConfigLocations configs={ownConfigs} />}
      {showRecentLocations && <RecentLocations />}
      {showCustomListLocationLists && <CustomListLocations />}
      {showCountryLocations && <CountryLocations />}
    </FlexColumn>
  );
}

export function LocationLists({ type }: LocationsListsProps) {
  return (
    <LocationListsProvider type={type}>
      <LocationsListsImpl />
    </LocationListsProvider>
  );
}
