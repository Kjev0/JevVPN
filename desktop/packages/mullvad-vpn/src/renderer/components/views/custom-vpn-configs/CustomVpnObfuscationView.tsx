import { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router';

import {
  CustomVpnObfuscation,
  CustomVpnObfuscationType,
  DEFAULT_SHADOWSOCKS_CIPHER,
  ICustomVpnConfig,
  isObfuscationEndpoint,
  validateObfuscation,
} from '../../../../shared/custom-vpn-config';
import { messages } from '../../../../shared/gettext';
import { useAppContext } from '../../../context';
import { useShadowsocksCiphers } from '../../../features/api-access-methods/hooks';
import { useCustomVpnConfigs } from '../../../features/custom-vpn-configs/hooks';
import { obfuscationLabel } from '../../../features/custom-vpn-configs/utils';
import { Button, Flex, Text } from '../../../lib/components';
import { FlexColumn } from '../../../lib/components/flex-column';
import { View } from '../../../lib/components/view';
import { useHistory } from '../../../lib/history';
import { AppNavigationHeader } from '../..';
import { SettingsGroup } from '../../cell/SettingsGroup';
import { SettingsRow } from '../../cell/SettingsRow';
import { SettingsSelect } from '../../cell/SettingsSelect';
import { SettingsTextInput } from '../../cell/SettingsTextInput';
import { BackAction } from '../../keyboard-navigation';
import { NavigationContainer } from '../../NavigationContainer';
import { NavigationScrollbars } from '../../NavigationScrollbars';
import { SettingsListbox } from '../../settings-listbox';
import { HeaderTitle } from '../../SettingsHeader';
import { StatusDialog } from '../../status-dialog';
import { errorMessage } from './CustomVpnConfigsView';

export function CustomVpnObfuscationView() {
  const { pop } = useHistory();
  const { id } = useParams<{ id: string }>();
  const config = useCustomVpnConfigs()?.find((config) => config.id === id);
  const title = messages.pgettext('custom-vpn-configs-view', 'Obfuscation');

  return (
    <View backgroundColor="darkBlue">
      <BackAction action={pop}>
        <NavigationContainer>
          <AppNavigationHeader title={title} />
          <NavigationScrollbars>
            <View.Content>
              <View.Container horizontalMargin="medium" flexDirection="column" gap="small">
                <HeaderTitle>{title}</HeaderTitle>
                {config && <ObfuscationSettings key={config.id} config={config} />}
              </View.Container>
            </View.Content>
          </NavigationScrollbars>
        </NavigationContainer>
      </BackAction>
    </View>
  );
}

function ObfuscationSettings({ config }: { config: ICustomVpnConfig }) {
  const { pop } = useHistory();
  const { setCustomVpnObfuscation } = useAppContext();
  const { shadowsocksCiphers } = useShadowsocksCiphers();
  const current = config.obfuscation;

  const [selected, setSelected] = useState<CustomVpnObfuscationType>(current.type);
  const [endpoint, setEndpoint] = useState('endpoint' in current ? current.endpoint : '');
  const [password, setPassword] = useState(current.type === 'shadowsocks' ? current.password : '');
  const [cipher, setCipher] = useState(
    current.type === 'shadowsocks' ? current.cipher : DEFAULT_SHADOWSOCKS_CIPHER,
  );
  const [error, setError] = useState<string>();

  const cipherItems = useMemo(
    () =>
      [...new Set([DEFAULT_SHADOWSOCKS_CIPHER, ...shadowsocksCiphers.map(({ name }) => name)])]
        .sort()
        .map((name) => ({ value: name, label: name })),
    [shadowsocksCiphers],
  );

  const needsServer = selected === 'udp2tcp' || selected === 'shadowsocks';
  const candidate = useMemo<CustomVpnObfuscation>(
    () =>
      selected === 'udp2tcp'
        ? { type: 'udp2tcp', endpoint }
        : selected === 'shadowsocks'
          ? { type: 'shadowsocks', endpoint, password, cipher }
          : { type: selected },
    [selected, endpoint, password, cipher],
  );
  // The stored password never reaches the renderer; an empty field keeps it.
  const keepsPassword = current.type === 'shadowsocks' && selected === 'shadowsocks' && !password;
  const valid =
    validateObfuscation(
      keepsPassword ? { type: 'shadowsocks', endpoint, password: 'stored', cipher } : candidate,
      config.amneziaAvailable,
    ) === undefined;

  const apply = useCallback(
    async (obfuscation: CustomVpnObfuscation) => {
      try {
        await setCustomVpnObfuscation(config.id, obfuscation);
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      }
    },
    [config.id, setCustomVpnObfuscation],
  );

  const onSelect = useCallback(
    async (type: CustomVpnObfuscationType) => {
      setSelected(type);
      // Methods without a server take effect at once, like the anti-censorship settings.
      if (type === 'off' || type === 'junk' || type === 'amnezia') await apply({ type });
    },
    [apply],
  );

  const save = useCallback(async () => {
    if (await apply(candidate)) pop();
  }, [apply, candidate, pop]);

  const onErrorDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setError(undefined);
  }, []);

  return (
    <FlexColumn gap="medium">
      <Text variant="labelTiny" color="whiteAlpha60">
        {messages.pgettext(
          'custom-vpn-configs-view',
          'Hides the WireGuard traffic of this config from networks that block VPNs. Junk packets work with any WireGuard server. AmneziaWG, UDP-over-TCP and Shadowsocks need matching software on the server.',
        )}
      </Text>

      <SettingsListbox value={selected} onValueChange={onSelect}>
        <SettingsListbox.Header>
          <SettingsListbox.Header.Item>
            <SettingsListbox.Header.Item.Label>
              {messages.pgettext('anti-censorship-view', 'Method')}
            </SettingsListbox.Header.Item.Label>
          </SettingsListbox.Header.Item>
        </SettingsListbox.Header>
        <SettingsListbox.Options>
          {(['off', 'junk', 'amnezia', 'udp2tcp', 'shadowsocks'] as const).map((type) => (
            <SettingsListbox.Options.BaseOption
              key={type}
              value={type}
              disabled={type === 'amnezia' && !config.amneziaAvailable}>
              {obfuscationLabel(type)}
            </SettingsListbox.Options.BaseOption>
          ))}
        </SettingsListbox.Options>
      </SettingsListbox>

      {!config.amneziaAvailable && (
        <Text variant="labelTiny" color="whiteAlpha60">
          {messages.pgettext(
            'custom-vpn-configs-view',
            'AmneziaWG can only be used with a config file that contains AmneziaWG parameters (Jc, S1, H1 and so on).',
          )}
        </Text>
      )}

      {needsServer && (
        <>
          <SettingsGroup title={messages.pgettext('api-access-methods-view', 'Server details')}>
            <SettingsRow
              label={messages.pgettext('api-access-methods-view', 'Server')}
              errorMessage={messages.pgettext(
                'custom-vpn-configs-view',
                'Please enter the server as host:port.',
              )}>
              <SettingsTextInput
                value={endpoint}
                placeholder="host:443"
                aria-label={messages.pgettext('api-access-methods-view', 'Server')}
                onUpdate={setEndpoint}
                validate={isObfuscationEndpoint}
              />
            </SettingsRow>
            {selected === 'shadowsocks' && (
              <>
                <SettingsRow label={messages.gettext('Password')}>
                  <SettingsTextInput
                    value={password}
                    placeholder={current.type === 'shadowsocks' ? '••••••••' : undefined}
                    aria-label={messages.gettext('Password')}
                    onUpdate={setPassword}
                  />
                </SettingsRow>
                <SettingsRow label={messages.gettext('Cipher')}>
                  <SettingsSelect
                    direction="up"
                    defaultValue={cipher}
                    onUpdate={setCipher}
                    items={cipherItems}
                  />
                </SettingsRow>
              </>
            )}
          </SettingsGroup>
          <Text variant="labelTiny" color="whiteAlpha60">
            {selected === 'udp2tcp'
              ? messages.pgettext(
                  'custom-vpn-configs-view',
                  'The server must run tcp2udp from mullvad/udp-over-tcp, forwarding to the WireGuard port.',
                )
              : messages.pgettext(
                  'custom-vpn-configs-view',
                  'The server must run a Shadowsocks server (for example ssserver) with UDP relay, forwarding to the WireGuard port.',
                )}
          </Text>
          <Flex justifyContent="flex-end">
            <Button width="fit" onClick={save} disabled={!valid} data-testid="save-obfuscation">
              <Button.Text>{messages.gettext('Save')}</Button.Text>
            </Button>
          </Flex>
        </>
      )}

      <StatusDialog
        variant="failure"
        open={error !== undefined}
        onOpenChange={onErrorDialogOpenChange}>
        <StatusDialog.Text>{error}</StatusDialog.Text>
        <StatusDialog.ButtonGroup>
          <StatusDialog.CloseButton>
            <StatusDialog.CloseButton.Text>
              {messages.gettext('Got it!')}
            </StatusDialog.CloseButton.Text>
          </StatusDialog.CloseButton>
        </StatusDialog.ButtonGroup>
      </StatusDialog>
    </FlexColumn>
  );
}
