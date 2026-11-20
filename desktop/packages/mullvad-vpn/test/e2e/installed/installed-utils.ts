import { startApp } from '../utils';

const testStartBuild = process.env.TEST_START_BUILD === '1';

export const startInstalledApp = async (): ReturnType<typeof startApp> => {
  const options = getStartOptions();

  return startApp(options);
};

function getStartOptions() {
  if (testStartBuild) {
    return {
      args: ['.'],
    };
  }

  return {
    executablePath: getAppInstallPath(),
  };
}

function getAppInstallPath(): string {
  switch (process.platform) {
    case 'win32':
      return 'C:\\Program Files\\JevVPN\\JevVPN.exe';
    case 'linux':
      return '/opt/JevVPN/mullvad-gui';
    case 'darwin':
      return '/Applications/JevVPN.app/Contents/MacOS/JevVPN';
    default:
      throw new Error('Platform not supported');
  }
}
