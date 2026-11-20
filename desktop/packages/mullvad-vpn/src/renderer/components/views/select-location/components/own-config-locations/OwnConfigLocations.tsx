import React from 'react';

import type { ICustomVpnConfig } from '../../../../../../shared/custom-vpn-config';
import { messages } from '../../../../../../shared/gettext';
import log from '../../../../../../shared/logging';
import { RoutePath } from '../../../../../../shared/routes';
import { useAppContext } from '../../../../../context';
import { FootnoteMiniSemiBold } from '../../../../../lib/components';
import { FlexColumn } from '../../../../../lib/components/flex-column';
import { SectionTitle } from '../../../../../lib/components/section-title';
import { TransitionType, useHistory } from '../../../../../lib/history';
import { useEffectEvent } from '../../../../../lib/utility-hooks';
import { StatusDialog } from '../../../../status-dialog';
import { useSelectLocationViewContext } from '../../SelectLocationViewContext';
import { Location } from '../location-list-item';

const protocolLabel = { wireguard: 'WireGuard', openvpn: 'OpenVPN' } as const;

function errorMessage(error: unknown): string {
  // Electron prefixes errors thrown in ipcMain handlers; show only the original message.
  return (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// Imported configs matching the search term, or undefined until loaded.
export function useOwnConfigs(): ICustomVpnConfig[] | undefined {
  const { getCustomVpnConfigs } = useAppContext();
  const { searchTerm } = useSelectLocationViewContext();
  const [configs, setConfigs] = React.useState<ICustomVpnConfig[]>();

  const load = useEffectEvent(async () => setConfigs(await getCustomVpnConfigs()));
  React.useEffect(() => void load(), []);

  return React.useMemo(() => {
    const term = searchTerm.toLowerCase();
    return configs?.filter((config) => config.name.toLowerCase().includes(term));
  }, [configs, searchTerm]);
}

type OwnConfigLocationProps = {
  config: ICustomVpnConfig;
  onSelect: (config: ICustomVpnConfig) => Promise<void>;
};

function OwnConfigLocation({ config, onSelect }: OwnConfigLocationProps) {
  const handleClick = React.useCallback(() => void onSelect(config), [config, onSelect]);

  return (
    <Location selected={config.active}>
      <Location.ListItem data-testid="own-config-location">
        <Location.ListItem.Trigger onClick={handleClick}>
          <Location.ListItem.Item>
            <FlexColumn>
              <Location.ListItem.Item.Label>{config.name}</Location.ListItem.Item.Label>
              <FootnoteMiniSemiBold color="whiteAlpha60">
                {`${protocolLabel[config.protocol]} · ${config.endpoint}`}
              </FootnoteMiniSemiBold>
            </FlexColumn>
          </Location.ListItem.Item>
        </Location.ListItem.Trigger>
      </Location.ListItem>
    </Location>
  );
}

export type OwnConfigLocationsProps = {
  configs: ICustomVpnConfig[];
};

export function OwnConfigLocations({ configs }: OwnConfigLocationsProps) {
  const { setActiveCustomVpnConfig, connectTunnel } = useAppContext();
  const history = useHistory();
  const titleId = React.useId();
  const [error, setError] = React.useState<string>();

  const select = React.useCallback(
    async (config: ICustomVpnConfig) => {
      try {
        await setActiveCustomVpnConfig(config.id);
      } catch (e) {
        setError(errorMessage(e));
        return;
      }
      history.push(RoutePath.main, { transition: TransitionType.dismiss });
      try {
        await connectTunnel();
      } catch (e) {
        log.error(`Failed to connect with config ${config.id}: ${(e as Error).message}`);
      }
    },
    [connectTunnel, history, setActiveCustomVpnConfig],
  );

  const gotoImport = React.useCallback(() => history.push(RoutePath.customVpnConfigs), [history]);

  const onErrorDialogOpenChange = React.useCallback((open: boolean) => {
    if (!open) setError(undefined);
  }, []);

  return (
    <FlexColumn
      as="section"
      aria-labelledby={titleId}
      gap="tiny"
      tabIndex={-1}
      data-focusable-heading>
      <SectionTitle>
        <SectionTitle.Title as="h2" id={titleId}>
          {
            // TRANSLATORS: Title of the section listing the user's imported VPN configs.
            messages.pgettext('select-location-view', 'Your configs')
          }
        </SectionTitle.Title>
        <SectionTitle.Divider />
      </SectionTitle>
      <FlexColumn gap="tiny">
        {configs.length === 0 ? (
          <Location>
            <Location.ListItem data-testid="own-config-location">
              <Location.ListItem.Trigger onClick={gotoImport}>
                <Location.ListItem.Item>
                  <Location.ListItem.Item.Label>
                    {
                      // TRANSLATORS: Shown in select location when no VPN configs are imported.
                      messages.pgettext('select-location-view', 'Import a config')
                    }
                  </Location.ListItem.Item.Label>
                </Location.ListItem.Item>
              </Location.ListItem.Trigger>
            </Location.ListItem>
          </Location>
        ) : (
          configs.map((config) => (
            <OwnConfigLocation key={config.id} config={config} onSelect={select} />
          ))
        )}
      </FlexColumn>

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
