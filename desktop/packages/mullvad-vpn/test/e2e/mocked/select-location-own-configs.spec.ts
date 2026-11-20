import { expect, test } from '@playwright/test';
import { Page } from 'playwright';

import { RoutePath } from '../../../src/shared/routes';
import { RoutesObjectModel } from '../route-object-models';
import { MockedTestUtils, startMockedApp } from './mocked-utils';

let page: Page;
let util: MockedTestUtils;
let routes: RoutesObjectModel;

const row = (name: string) => page.getByTestId('own-config-location').filter({ hasText: name });

test.describe('With subscription', () => {
  test.beforeAll(async () => {
    ({ page, util } = await startMockedApp());
    routes = new RoutesObjectModel(page, util);
    await util.expectRoute(RoutePath.main);
    await routes.main.gotoSelectLocation();
  });

  test.afterAll(async () => {
    await util?.closePage();
  });

  test('Own configs are listed above countries', async () => {
    await expect(page.getByRole('heading', { name: 'Your configs' })).toBeVisible();
    await expect(page.getByTestId('own-config-location')).toHaveCount(2);
    await expect(row('home-router')).toContainText('WireGuard · 203.0.113.7:51820');
    await expect(row('work-office')).toContainText('OpenVPN · vpn.example.com:1194');
    await expect(page.getByTestId('mullvad-servers-locked')).toHaveCount(0);

    const configsTop = (await row('home-router').boundingBox())!.y;
    const countriesTop = (await routes.selectLocation.getAllLocationsSection().boundingBox())!.y;
    expect(configsTop).toBeLessThan(countriesTop);
  });

  test('Clicking an OpenVPN config shows error', async () => {
    await row('work-office').getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('only supports WireGuard');
    await dialog.getByRole('button', { name: 'Got it!' }).click();
    await expect(dialog).not.toBeVisible();
    await util.expectRoute(RoutePath.selectLocation);
  });

  test('Clicking a WireGuard config goes to main and shows it as target', async () => {
    await row('home-router').getByRole('button').click();
    await util.expectRoute(RoutePath.main);
    await expect(page.getByLabel('Select location')).toContainText('home-router');
  });

  test('Picking a country deactivates the active config', async () => {
    await routes.main.gotoSelectLocation();
    await Promise.all([
      util.ipc.settings.setRelaySettings.expect(),
      util.ipc.tunnel.connect.expect(),
      routes.selectLocation.getLocationsInAllLocations().first().click(),
    ]);
    await util.expectRoute(RoutePath.main);
    await expect(page.getByLabel('Select location')).not.toContainText('home-router');
  });
});

test.describe('Without subscription', () => {
  test.beforeAll(async () => {
    ({ page, util } = await startMockedApp());
    routes = new RoutesObjectModel(page, util);
    await util.expectRoute(RoutePath.main);
    await util.ipc.account.device.notify({
      type: 'logged out',
      deviceState: { type: 'logged out' },
    });
    await util.expectRoute(RoutePath.login);
    await page.getByTestId('skip-button').click();
    await util.expectRoute(RoutePath.main);
    await routes.main.gotoSelectLocation();
  });

  test.afterAll(async () => {
    await util?.closePage();
  });

  test('Only own configs and the login row are listed', async () => {
    await expect(page.getByTestId('own-config-location')).toHaveCount(2);
    await expect(page.getByTestId('mullvad-servers-locked')).toHaveText(
      'Log in or add time to use Mullvad servers',
    );
    await expect(routes.selectLocation.getAllLocationsSection()).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Recents' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Custom lists' })).toHaveCount(0);
    await expect(page.getByLabel('Open select location menu')).toHaveCount(0);
  });

  test('Login row opens login view', async () => {
    await page.getByTestId('mullvad-servers-locked').getByRole('button').click();
    await util.expectRoute(RoutePath.login);
  });
});
