# SLP Nexus — Capacitor Android APK Setup Guide

## What's Included

```
capacitor-setup/
├── www/
│   └── index.html          ← Updated HTML with Capacitor integration
├── android-icons/
│   ├── mipmap-mdpi/        ← 48px icons
│   ├── mipmap-hdpi/        ← 72px icons
│   ├── mipmap-xhdpi/       ← 96px icons
│   ├── mipmap-xxhdpi/      ← 144px icons
│   ├── mipmap-xxxhdpi/     ← 192px icons
│   ├── ic_launcher.xml     ← Adaptive icon config
│   ├── ic_launcher_round.xml
│   ├── playstore-icon.png  ← 512x512 Play Store icon
│   └── splash.png          ← 2732x2732 splash screen
├── scripts/
│   └── copy-icons.js       ← Auto-copy icons to Android project
├── capacitor.config.ts     ← Capacitor configuration
├── package.json            ← Dependencies & scripts
└── SETUP.md                ← This file
```

## Changes Made to index.html

1. **viewport-fit=cover** — Handles notches and status bars
2. **Safe area CSS** — `env(safe-area-inset-*)` padding for notch devices
3. **Capacitor detection** — `window.isCapacitor()` helper function
4. **Android back button** — Routes to existing popstate handler
5. **App resume** — Refreshes data when app returns to foreground
6. **Deep link handler** — Catches ICICI payment callbacks
7. **Payment redirect** — Uses Capacitor Browser plugin (in-app browser) instead of `window.location.href`
8. **Service worker disabled** — In native mode, SW is unregistered (Capacitor handles caching)

---

## Step-by-Step Setup

### 1. Prepare Your Project

```bash
cd ~/lt-foodhub

# Copy the updated files from this package
cp capacitor-setup/www/index.html index.html
cp capacitor-setup/www/index.html www/index.html
cp capacitor-setup/capacitor.config.ts .
cp capacitor-setup/package.json .
mkdir -p scripts
cp capacitor-setup/scripts/copy-icons.js scripts/
cp -r capacitor-setup/android-icons .
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Initialize Capacitor Android

```bash
# Add Android platform (if not already added)
npx cap add android
```

### 4. Copy Icons to Android Project

```bash
# Auto-copy all icon sizes
node scripts/copy-icons.js

# Also copy the adaptive icon XMLs
cp android-icons/ic_launcher.xml android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
cp android-icons/ic_launcher_round.xml android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
```

### 5. Update Android App Name & Config

Edit `android/app/src/main/res/values/strings.xml`:
```xml
<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">SLP Nexus</string>
    <string name="title_activity_main">SLP Nexus</string>
    <string name="package_name">com.slphospitality.nexus</string>
    <string name="custom_url_scheme">com.slphospitality.nexus</string>
</resources>
```

### 6. Add Deep Link for Payment Callback

Edit `android/app/src/main/AndroidManifest.xml`, add inside `<activity>`:
```xml
<!-- Deep link for ICICI payment callback -->
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="slp-nexus.vercel.app" />
</intent-filter>
```

### 7. Sync & Build

```bash
# Copy web assets to Android
npx cap sync android

# Build debug APK
cd android
./gradlew assembleDebug

# Your APK is at:
# android/app/build/outputs/apk/debug/app-debug.apk
```

### 8. Quick Copy to Downloads

```bash
cp android/app/build/outputs/apk/debug/app-debug.apk '/c/Users/tiwar/Downloads/SLP-Nexus.apk'
```

---

## One-Liner Rebuild (after any HTML change)

```bash
cp index.html www/index.html && npx cap sync android && cd android && ./gradlew assembleDebug && cp app/build/outputs/apk/debug/app-debug.apk '/c/Users/tiwar/Downloads/SLP-Nexus.apk' && cd ..
```

---

## Payment Gateway Note

The ICICI payment redirect now uses Capacitor's **Browser plugin** (in-app browser) when running as a native app. The payment page opens fullscreen, and the return URL (`slp-nexus.vercel.app`) is caught via deep link, routing back into the app.

For the deep link to work:
- The return URL in your ICICI config must be: `https://slp-nexus.vercel.app`
- The AndroidManifest intent-filter above handles this

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| White screen on launch | Check `www/index.html` exists and `npx cap sync` was run |
| Icons not showing | Re-run `node scripts/copy-icons.js` then `npx cap sync` |
| Payment not returning | Verify deep link in AndroidManifest & ICICI return URL |
| Fonts not loading | Ensure internet permission in AndroidManifest (default in Cap) |
| Back button exits app | The Capacitor integration handles this — check console logs |
