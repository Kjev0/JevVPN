import styled from 'styled-components';

import { TunnelState } from '../../../../../../../../shared/daemon-rpc-types';
import { useActiveWireguardConfig } from '../../../../../../../features/custom-vpn-configs/hooks';
import { colors } from '../../../../../../../lib/foundations';
import { useSelector } from '../../../../../../../redux/store';
import { largeText } from '../../../../../../common-styles';
import Marquee from '../../../../../../Marquee';
import { ConnectionPanelAccordion } from '../../../../styles';

const StyledLocation = styled.span(largeText, {
  color: colors.white,
  flexShrink: 0,
});

export function Location() {
  const connection = useSelector((state) => state.connection);
  const activeConfig = useActiveWireguardConfig();
  const state = connection.status.state;
  // When tunneling to an own config, it is the connection target instead of a Mullvad location.
  const text =
    activeConfig && (state === 'connected' || state === 'connecting')
      ? activeConfig.name
      : getLocationText(connection.status, connection.country, connection.city);

  return (
    <ConnectionPanelAccordion expanded={connection.status.state !== 'error'}>
      <StyledLocation>
        <Marquee>{text}</Marquee>
      </StyledLocation>
    </ConnectionPanelAccordion>
  );
}

function getLocationText(tunnelState: TunnelState, country?: string, city?: string): string {
  country = country ?? '';

  switch (tunnelState.state) {
    case 'connected':
    case 'connecting':
      return city ? `${country}, ${city}` : country;
    case 'disconnecting':
    case 'disconnected':
      return country;
    case 'error':
      return '';
  }
}
