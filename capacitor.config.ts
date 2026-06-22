import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mtmanagement.bookkeeper',
  appName: 'Bookkeeper',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
