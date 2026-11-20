import { expect, test } from '@playwright/test';
import { Page } from 'playwright';

import { RoutePath } from '../../../src/shared/routes';
import { RoutesObjectModel } from '../route-object-models';
import { MockedTestUtils, startMockedApp } from './mocked-utils';

let page: Page;
let util: MockedTestUtils;
let routes: RoutesObjectModel;

test.beforeAll(async () => {
  ({ page, util } = await startMockedApp());
  routes = new RoutesObjectModel(page, util);
  await util.expectRoute(RoutePath.main);
  await routes.main.gotoSelectLocation();
});

test.afterAll(async () => {
  await util?.closePage();
});

const row = (name: string) => page.getByTestId('own-config-location').filter({ hasText: name });

test('Own configs are listed above countries', async () => {
  await expect(page.getByRole('heading', { name: 'Your configs' })).toBeVisible();
  await expect(page.getByTestId('own-config-location')).toHaveCount(2);
  await expect(row('home-router')).toContainText('WireGuard · 203.0.113.7:51820');
  await expect(row('work-office')).toContainText('OpenVPN · vpn.example.com:1194');

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

test('Clicking a WireGuard config goes to main', async () => {
  await row('home-router').getByRole('button').click();
  await util.expectRoute(RoutePath.main);
});
