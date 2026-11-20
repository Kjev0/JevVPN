import { expect, test } from '@playwright/test';
import { Page } from 'playwright';

import { RoutePath } from '../../../src/shared/routes';
import { MockedTestUtils, startMockedApp } from './mocked-utils';

let page: Page;
let util: MockedTestUtils;

test.describe('Guest mode', () => {
  test.beforeAll(async () => {
    ({ page, util } = await startMockedApp());
    await util.expectRoute(RoutePath.main);
    await util.ipc.account.device.notify({
      type: 'logged out',
      deviceState: { type: 'logged out' },
    });
    await util.expectRoute(RoutePath.login);
  });

  test.afterAll(async () => {
    await util?.closePage();
  });

  test('Skip on login view opens main view', async () => {
    await page.getByTestId('skip-button').click();
    await util.expectRoute(RoutePath.main);
    await expect(page.getByTestId('guest-mode-hint')).toHaveText(
      'Guest mode: import a WireGuard config to connect. Mullvad servers require a Mullvad account.',
    );
  });

  test('Connect with active WireGuard config connects', async () => {
    await Promise.all([
      util.ipc.tunnel.connect.expect(),
      page.getByRole('button', { name: 'Connect', exact: true }).click(),
    ]);
    await util.expectRoute(RoutePath.main);
  });

  test('Connect without active config opens VPN configs', async () => {
    await util.ipc.customVpnConfigs.get.handle([]);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await util.expectRoute(RoutePath.customVpnConfigs);
  });

  test('Logging out ends guest mode and shows login view', async () => {
    await util.ipc.account.device.notify({
      type: 'logged out',
      deviceState: { type: 'logged out' },
    });
    await util.expectRoute(RoutePath.login);
    await expect(page.getByTestId('skip-button')).toBeVisible();
  });
});
