import { messages } from '../../../../../../shared/gettext';
import { RoutePath } from '../../../../../../shared/routes';
import { ListItemProps } from '../../../../../lib/components/list-item';
import { SettingsNavigationListItem } from '../../../../settings-navigation-list-item';

export type CustomVpnConfigsListItemProps = Omit<ListItemProps, 'children'>;

export function CustomVpnConfigsListItem(props: CustomVpnConfigsListItemProps) {
  return (
    <SettingsNavigationListItem to={RoutePath.customVpnConfigs} {...props}>
      <SettingsNavigationListItem.Item>
        <SettingsNavigationListItem.Item.Label>
          {
            // TRANSLATORS: Navigation button to the imported VPN configs view
            messages.pgettext('settings-view', 'VPN configs')
          }
        </SettingsNavigationListItem.Item.Label>
        <SettingsNavigationListItem.Item.ActionGroup>
          <SettingsNavigationListItem.Item.Icon icon="chevron-right" />
        </SettingsNavigationListItem.Item.ActionGroup>
      </SettingsNavigationListItem.Item>
    </SettingsNavigationListItem>
  );
}
