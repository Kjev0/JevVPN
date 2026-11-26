import type { CustomVpnObfuscationType } from '../../../../shared/custom-vpn-config';
import { messages } from '../../../../shared/gettext';

export function obfuscationLabel(type: CustomVpnObfuscationType): string {
  switch (type) {
    case 'off':
      return messages.gettext('Off');
    case 'junk':
      // TRANSLATORS: Obfuscation method that sends random packets before the WireGuard handshake.
      return messages.pgettext('custom-vpn-configs-view', 'Junk packets');
    case 'amnezia':
      return 'AmneziaWG';
    case 'udp2tcp':
      return messages.pgettext('wireguard-settings-view', 'UDP-over-TCP');
    case 'shadowsocks':
      return messages.pgettext('wireguard-settings-view', 'Shadowsocks');
  }
}
