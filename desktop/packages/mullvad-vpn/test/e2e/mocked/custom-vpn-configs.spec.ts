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

test('Navigate to VPN configs', async () => {
  await page.click('button[aria-label="Settings"]');
  await util.expectRoute(RoutePath.settings);
  await page.getByText('VPN configs').click();
  await util.expectRoute(RoutePath.customVpnConfigs);
});

test('Lists seeded configs', async () => {
  await expect(page.getByTestId('vpn-config')).toHaveCount(2);
  await expect(row('home-router')).toContainText('WireGuard · 203.0.113.7:51820');
  await expect(row('home-router')).toContainText('In use');
  await expect(row('home-router').getByRole('switch')).toBeChecked();
  await expect(row('work-office')).toContainText('OpenVPN · vpn.example.com:1194');
  await expect(row('work-office').getByRole('switch')).not.toBeChecked();
});

test('Activating OpenVPN config shows error', async () => {
  await row('work-office').getByRole('switch').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('only supports WireGuard');
  await dialog.getByRole('button', { name: 'Got it!' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row('home-router').getByRole('switch')).toBeChecked();
});

test('Delete config via context menu', async () => {
  await row('work-office').getByRole('button').first().click();
  await page.getByRole('button', { name: 'Delete' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete work-office?');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('vpn-config')).toHaveCount(1);
  await expect(row('work-office')).toHaveCount(0);
});
