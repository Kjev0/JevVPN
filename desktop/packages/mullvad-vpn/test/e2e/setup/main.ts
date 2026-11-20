import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import * as path from 'path';

import { getDefaultSettings } from '../../../src/main/default-settings';
import { changeIpcWebContents, IpcMainEventChannel } from '../../../src/main/ipc-event-channel';
import { loadTranslations } from '../../../src/main/load-translations';
import { ICustomVpnConfig, parseVpnConfig } from '../../../src/shared/custom-vpn-config';
import {
  DeviceState,
  IAccountData,
  IAppVersionInfo,
  ILocation,
} from '../../../src/shared/daemon-rpc-types';
import { messages, relayLocations } from '../../../src/shared/gettext';
import { IGuiSettingsState } from '../../../src/shared/gui-settings-state';
import { ITranslations, MacOsScrollbarVisibility } from '../../../src/shared/ipc-schema';
import { ICurrentAppVersionInfo } from '../../../src/shared/ipc-types';
import { mockData } from '../mock-data';
import { getRelayPartitions } from './mock-relay-selector';

const DEBUG = false;
const TEST_SHOW_WINDOW = process.env.TEST_SHOW_WINDOW === '1';
const CI_E2E = process.env.CI === 'e2e';

class ApplicationMain {
  private guiSettings: IGuiSettingsState = {
    preferredLocale: 'en',
    autoConnect: false,
    enableSystemNotifications: true,
    monochromaticIcon: false,
    startMinimized: false,
    unpinnedWindow: process.platform !== 'win32' && process.platform !== 'darwin',
    browsedForSplitTunnelingApplications: [],
    changelogDisplayedForVersion: '',
    updateDismissedForVersion: '',
    settingsMigrationNotificationDismissedForVersion: '',
    completedSettingsMigrations: [],
    animateMap: true,
    guestMode: false,
  };

  private settings = getDefaultSettings();

  private customVpnConfigs: ICustomVpnConfig[] = [
    {
      id: '1',
      name: 'home-router',
      protocol: 'wireguard',
      endpoint: '203.0.113.7:51820',
      active: true,
    },
    {
      id: '2',
      name: 'work-office',
      protocol: 'openvpn',
      endpoint: 'vpn.example.com:1194',
      active: false,
    },
  ];

  private translations: ITranslations = { locale: this.guiSettings.preferredLocale };

  private isConnectedToDaemon = true;

  private accountData: IAccountData = {
    expiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  private deviceState: DeviceState = {
    type: 'logged in',
    accountAndDevice: {
      accountNumber: '1234123412341234',
      device: {
        id: '1234',
        name: 'Testing Device',
        created: new Date(),
      },
    },
  };

  private currentVersion: ICurrentAppVersionInfo = {
    gui: '2000.1',
    daemon: '2000.1',
    isConsistent: true,
    isBeta: false,
  };
  private upgradeVersion: IAppVersionInfo = {
    supported: true,
    suggestedUpgrade: undefined,
  };

  private location: ILocation = {
    country: 'Sweden',
    city: 'Gothenburg',
    latitude: 58,
    longitude: 12,
    mullvadExitIp: false,
  };

  public constructor() {
    app.enableSandbox();
    app.on('ready', this.onReady);
  }

  private onReady = async () => {
    this.updateCurrentLocale('en');

    const window = new BrowserWindow({
      useContentSize: true,
      width: 320,
      height: 568,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: DEBUG,
      titleBarStyle: 'hidden',
      frame: true,
      webPreferences: {
        offscreen: CI_E2E && !TEST_SHOW_WINDOW,
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        contextIsolation: true,
        spellcheck: false,
        devTools: DEBUG,
      },
    });

    changeIpcWebContents(window.webContents);

    this.registerIpcListeners();

    await window.loadFile(path.join(import.meta.dirname, 'index.html'));

    if (process.argv.includes('--show-window')) {
      window.show();
    }

    if (DEBUG) {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  };

  private registerIpcListeners() {
    IpcMainEventChannel.state.handleGet(() => ({
      isConnected: this.isConnectedToDaemon,
      autoStart: false,
      accountData: this.accountData,
      accountHistory: undefined,
      tunnelState: { state: 'disconnected', location: this.location, lockedDown: false },
      settings: this.settings,
      isPerformingPostUpgrade: false,
      deviceState: this.deviceState,
      relayList: {
        relayList: mockData.relayList,
        wireguardEndpointData: mockData.wireguardEndpointData,
      },
      currentVersion: this.currentVersion,
      upgradeVersion: this.upgradeVersion,
      guiSettings: this.guiSettings,
      translations: this.translations,
      splitTunnelingApplications: [],
      macOsScrollbarVisibility: MacOsScrollbarVisibility.whenScrolling,
      changelog: [],
      migrations: [],
      navigationHistory: undefined,
      scrollPositions: {},
      isMacOs13OrNewer: true,
    }));

    IpcMainEventChannel.relays.handlePartitionRelays(async (predicate) => {
      const relayPartitions = getRelayPartitions(predicate, mockData.relayList);
      return Promise.resolve(relayPartitions);
    });

    IpcMainEventChannel.guiSettings.handleSetGuestMode((guestMode) => {
      this.guiSettings.guestMode = guestMode;
      IpcMainEventChannel.guiSettings.notify?.(this.guiSettings);
    });

    IpcMainEventChannel.guiSettings.handleSetPreferredLocale((locale) => {
      this.updateCurrentLocale(locale);
      IpcMainEventChannel.guiSettings.notify?.(this.guiSettings);
      return Promise.resolve(this.translations);
    });

    // In-memory stand-in for src/main/custom-vpn-configs.ts (no daemon in mocked mode).
    IpcMainEventChannel.customVpnConfigs.handleGet(() => Promise.resolve(this.customVpnConfigs));
    IpcMainEventChannel.customVpnConfigs.handleImportFile(async (filePath) => {
      const text = await fs.promises.readFile(filePath, 'utf8');
      const config = {
        id: String(Date.now()),
        ...parseVpnConfig(path.basename(filePath), text),
        active: false,
      };
      this.customVpnConfigs.push(config);
      return config;
    });
    IpcMainEventChannel.customVpnConfigs.handleRemove((id) => {
      this.customVpnConfigs = this.customVpnConfigs.filter((config) => config.id !== id);
      return Promise.resolve();
    });
    IpcMainEventChannel.customVpnConfigs.handleSetActive((id) => {
      if (this.customVpnConfigs.find((config) => config.id === id)?.protocol === 'openvpn') {
        return Promise.reject(new Error('The JevVPN service only supports WireGuard tunnels.'));
      }
      this.customVpnConfigs.forEach((config) => (config.active = config.id === id));
      return Promise.resolve();
    });
  }

  private updateCurrentLocale(locale: string) {
    this.guiSettings.preferredLocale = locale;

    const messagesTranslations = loadTranslations(this.guiSettings.preferredLocale, messages);
    const relayLocationsTranslations = loadTranslations(
      this.guiSettings.preferredLocale,
      relayLocations,
    );

    this.translations = {
      locale: this.guiSettings.preferredLocale,
      messages: messagesTranslations,
      relayLocations: relayLocationsTranslations,
    };
  }
}

new ApplicationMain();
