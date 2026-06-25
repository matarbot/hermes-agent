import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.nousresearch.hermes.mobile',
  appName: 'Hermes',
  webDir: 'www',
  server: {
    // In dev mode Capacitor loads the app from the Vite dev server
    // instead of the bundled www/ files.
    url: 'http://127.0.0.1:5175',
    cleartext: true,
  },
  plugins: {
    SecureStorage: {
      supportedBiometries: ['FaceID', 'TouchID'],
    },
    LocalNotifications: {
      smallIcon: 'res/icon.png',
      iconColor: '#3b82f6',
    },
  },
}

export default config
