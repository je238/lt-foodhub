import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.slphospitality.nexus',
  appName: 'SLP Nexus',
  webDir: 'www',
  
  // Server config — loads local files (no live reload in prod)
  server: {
    androidScheme: 'https',
    // Uncomment below for dev live reload:
    // url: 'http://YOUR_LOCAL_IP:5173',
    // cleartext: true,
  },
  
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#FFFFFF',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',           // dark text on light bg
      backgroundColor: '#1E3A5F',
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    Browser: {
      // Used for ICICI payment gateway redirect
    },
  },

  android: {
    allowMixedContent: true,   // needed for some CDN resources
    backgroundColor: '#FFFFFF',
  },
};

export default config;
