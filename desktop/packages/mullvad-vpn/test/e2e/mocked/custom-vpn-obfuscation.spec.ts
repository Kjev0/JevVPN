import { expect, test } from '@playwright/test';
import { Page } from 'playwright';

import { RoutePath } from '../../../src/shared/routes';
import { MockedTestUtils, startMockedApp } from './mocked-utils';

let page: Page;
let util: MockedTestUtils;

test.beforeAll(async () => {
  ({ page, util } = await startMockedApp());
  await util.expectRoute(RoutePath.main);
});

test.afterAll(async () => {
  await util?.closePage();
});

const row = (name: string) => page.getByTestId('vpn-config').filter({ hasText: name });
const option = (name: string) => page.getByRole('option', { name, exact: true });
const serverInput = () => page.getByRole('textbox', { name: 'Server' }).first();
const saveButton = () => page.getByTestId('save-obfuscation');

async function openObfuscation(name: string) {
  await row(name).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Obfuscation' }).click();
  await util.expectRoute('/settings/custom-vpn-configs/obfuscation/1');
}

test('Navigate to VPN configs', async () => {
  await page.click('button[aria-label="Settings"]');
  await util.expectRoute(RoutePath.settings);
  await page.getByText('VPN configs').click();
  await util.expectRoute(RoutePath.customVpnConfigs);
});

test('OpenVPN configs have no obfuscation menu item', async () => {
  await row('work-office').getByRole('button').first().click();
  await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Obfuscation' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Open obfuscation for a WireGuard config', async () => {
  await openObfuscation('home-router');
  await expect(option('Off')).toHaveAttribute('aria-selected', 'true');
  // The seeded config has no AmneziaWG parameters.
  await expect(option('AmneziaWG')).toHaveAttribute('aria-disabled', 'true');
});

test('Junk packets apply at once', async () => {
  await option('Junk packets').click();
  await expect(option('Junk packets')).toHaveAttribute('aria-selected', 'true');
  await page.click('button[aria-label="Back"]');
  await util.expectRoute(RoutePath.customVpnConfigs);
  await expect(row('home-router')).toContainText('Junk packets');
});

test('UDP-over-TCP needs a valid server', async () => {
  await openObfuscation('home-router');
  await option('UDP-over-TCP').click();
  await expect(saveButton()).toBeDisabled();
  await serverInput().fill('not a server');
  await expect(saveButton()).toBeDisabled();
  await serverInput().fill('relay.example.com:443');
  await expect(saveButton()).toBeEnabled();
  await saveButton().click();
  await util.expectRoute(RoutePath.customVpnConfigs);
  await expect(row('home-router')).toContainText('UDP-over-TCP');
});

test('Shadowsocks needs a password', async () => {
  await openObfuscation('home-router');
  await expect(option('UDP-over-TCP')).toHaveAttribute('aria-selected', 'true');
  await option('Shadowsocks').click();
  await expect(serverInput()).toHaveValue('relay.example.com:443');
  await expect(saveButton()).toBeDisabled();
  await page.getByRole('textbox', { name: 'Password' }).first().fill('s3cret');
  await expect(saveButton()).toBeEnabled();
  await saveButton().click();
  await util.expectRoute(RoutePath.customVpnConfigs);
  await expect(row('home-router')).toContainText('Shadowsocks');
});
