import { useCallback, useEffect, useMemo, useState } from 'react';
import { sprintf } from 'sprintf-js';
import styled from 'styled-components';

import { ICustomVpnConfig } from '../../../../shared/custom-vpn-config';
import { messages } from '../../../../shared/gettext';
import { useAppContext } from '../../../context';
import { Button, Container, Flex } from '../../../lib/components';
import { FlexColumn } from '../../../lib/components/flex-column';
import { Switch } from '../../../lib/components/switch';
import { View } from '../../../lib/components/view';
import { useHistory } from '../../../lib/history';
import { useEffectEvent } from '../../../lib/utility-hooks';
import { AppNavigationHeader } from '../..';
import * as Cell from '../../cell';
import {
  ContextMenu,
  ContextMenuContainer,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../ContextMenu';
import { BackAction } from '../../keyboard-navigation';
import { NavigationContainer } from '../../NavigationContainer';
import { NavigationScrollbars } from '../../NavigationScrollbars';
import SettingsHeader, { HeaderSubTitle, HeaderTitle } from '../../SettingsHeader';
import { StatusDialog } from '../../status-dialog';

const StyledNameLabel = styled(Cell.Label)({
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// SubLabel has a fixed height, so long text must not wrap.
const StyledSubLabelText = styled.span({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

const protocolLabel = { wireguard: 'WireGuard', openvpn: 'OpenVPN' } as const;

function errorMessage(error: unknown): string {
  // Electron prefixes errors thrown in ipcMain handlers; show only the original message.
  return (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function CustomVpnConfigsView() {
  const { pop } = useHistory();
  const { getCustomVpnConfigs, importCustomVpnConfig, showOpenDialog } = useAppContext();
  const [configs, setConfigs] = useState<ICustomVpnConfig[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(
    async () => setConfigs(await getCustomVpnConfigs()),
    [getCustomVpnConfigs],
  );
  const onMount = useEffectEvent(refresh);
  useEffect(() => void onMount(), []);

  const onErrorDialogOpenChange = useCallback((open: boolean) => {
    if (!open) setError(undefined);
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (e) {
        setError(errorMessage(e));
      }
      await refresh();
    },
    [refresh],
  );

  const importFile = useCallback(async () => {
    const result = await showOpenDialog({
      properties: ['openFile'],
      buttonLabel: messages.gettext('Import'),
      filters: [
        { name: 'VPN configuration', extensions: ['conf', 'ovpn'] },
        { name: 'WireGuard', extensions: ['conf'] },
        { name: 'OpenVPN', extensions: ['ovpn'] },
      ],
    });
    const path = result.filePaths[0];
    if (!result.canceled && path) {
      await run(() => importCustomVpnConfig(path));
    }
  }, [importCustomVpnConfig, run, showOpenDialog]);

  return (
    <View backgroundColor="darkBlue">
      <BackAction action={pop}>
        <NavigationContainer>
          <AppNavigationHeader
            title={
              // TRANSLATORS: Title label in navigation bar
              messages.pgettext('custom-vpn-configs-view', 'VPN configs')
            }>
            <AppNavigationHeader.Info>
              <AppNavigationHeader.Info.Button />
              <AppNavigationHeader.Info.Dialog>
                <AppNavigationHeader.Info.Dialog.Title>
                  {messages.pgettext('custom-vpn-configs-view', 'VPN configs')}
                </AppNavigationHeader.Info.Dialog.Title>
                <AppNavigationHeader.Info.Dialog.Text>
                  {messages.pgettext(
                    'custom-vpn-configs-view',
                    'WireGuard configurations are used to connect when turned on. Only one configuration can be in use at a time.',
                  )}
                </AppNavigationHeader.Info.Dialog.Text>
                <AppNavigationHeader.Info.Dialog.Text>
                  {messages.pgettext(
                    'custom-vpn-configs-view',
                    'OpenVPN configurations can be imported and stored, but connecting with them is not supported yet.',
                  )}
                </AppNavigationHeader.Info.Dialog.Text>
                <AppNavigationHeader.Info.Dialog.Text>
                  {messages.pgettext(
                    'custom-vpn-configs-view',
                    'Imported files can contain private keys. They are stored encrypted on this device.',
                  )}
                </AppNavigationHeader.Info.Dialog.Text>
              </AppNavigationHeader.Info.Dialog>
            </AppNavigationHeader.Info>
          </AppNavigationHeader>
          <NavigationScrollbars fillContainer>
            <View.Content>
              <SettingsHeader>
                <HeaderTitle>
                  {messages.pgettext('custom-vpn-configs-view', 'VPN configs')}
                </HeaderTitle>
                <HeaderSubTitle>
                  {messages.pgettext(
                    'custom-vpn-configs-view',
                    'Import WireGuard (.conf) or OpenVPN (.ovpn) configuration files from any provider. Turn one on to tunnel through it instead of the JevVPN servers.',
                  )}
                </HeaderSubTitle>
              </SettingsHeader>

              <Flex flexDirection="column" gap="large">
                {configs.length > 0 ? (
                  <FlexColumn>
                    {configs.map((config) => (
                      <CustomVpnConfigRow key={config.id} config={config} run={run} />
                    ))}
                  </FlexColumn>
                ) : (
                  <Cell.CellFooter data-testid="vpn-configs-empty">
                    <Cell.CellFooterText>
                      {messages.pgettext(
                        'custom-vpn-configs-view',
                        'No VPN configs imported yet. Use Import to add a .conf or .ovpn file.',
                      )}
                    </Cell.CellFooterText>
                  </Cell.CellFooter>
                )}
                <Container horizontalMargin="medium" justifyContent="flex-end">
                  <Button width="fit" onClick={importFile} data-testid="import-vpn-config">
                    <Button.Text>{messages.gettext('Import')}</Button.Text>
                  </Button>
                </Container>
              </Flex>
            </View.Content>
          </NavigationScrollbars>
        </NavigationContainer>
      </BackAction>

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
    </View>
  );
}

interface CustomVpnConfigRowProps {
  config: ICustomVpnConfig;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

function CustomVpnConfigRow({ config, run }: CustomVpnConfigRowProps) {
  const { removeCustomVpnConfig, setActiveCustomVpnConfig } = useAppContext();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const toggle = useCallback(
    (on: boolean) => run(() => setActiveCustomVpnConfig(on ? config.id : undefined)),
    [config.id, run, setActiveCustomVpnConfig],
  );

  const confirmRemove = useCallback(() => {
    setDeleteDialogOpen(false);
    void run(() => removeCustomVpnConfig(config.id));
  }, [config.id, removeCustomVpnConfig, run]);

  const menuItems = useMemo<Array<ContextMenuItem>>(
    () => [
      {
        type: 'item' as const,
        label: messages.gettext('Delete'),
        onClick: () => setDeleteDialogOpen(true),
      },
    ],
    [],
  );

  return (
    <Cell.Row data-testid="vpn-config">
      <Cell.LabelContainer>
        <StyledNameLabel>{config.name}</StyledNameLabel>
        <Cell.SubLabel>
          <StyledSubLabelText>
            {`${protocolLabel[config.protocol]} · ${config.endpoint}`}
            {config.active && ` · ${messages.pgettext('api-access-methods-view', 'In use')}`}
          </StyledSubLabelText>
        </Cell.SubLabel>
      </Cell.LabelContainer>
      <Flex gap="small" alignItems="center">
        <ContextMenuContainer>
          <ContextMenuTrigger />
          <ContextMenu items={menuItems} align="right" />
        </ContextMenuContainer>
        <Switch checked={config.active} onCheckedChange={toggle}>
          <Switch.Input aria-label={config.name} />
        </Switch>
      </Flex>

      <StatusDialog variant="warning" open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <StatusDialog.Subtitle>
          {sprintf(messages.pgettext('api-access-methods-view', 'Delete %(name)s?'), {
            name: config.name,
          })}
        </StatusDialog.Subtitle>
        <StatusDialog.ButtonGroup>
          <StatusDialog.Button onClick={confirmRemove} color="destructive">
            <StatusDialog.Button.Text>{messages.gettext('Delete')}</StatusDialog.Button.Text>
          </StatusDialog.Button>
          <StatusDialog.CloseButton>
            <StatusDialog.CloseButton.Text>
              {messages.gettext('Cancel')}
            </StatusDialog.CloseButton.Text>
          </StatusDialog.CloseButton>
        </StatusDialog.ButtonGroup>
      </StatusDialog>
    </Cell.Row>
  );
}
