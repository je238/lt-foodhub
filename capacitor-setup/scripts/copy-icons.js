/**
 * copy-icons.js — Copies generated app icons into the Android project
 * Run: node scripts/copy-icons.js
 */
const fs = require('fs');
const path = require('path');

const iconSource = path.join(__dirname, '..', 'android-icons');
const androidRes = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const folders = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
const files = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png', 'ic_launcher_background.png'];

folders.forEach(folder => {
  const srcDir = path.join(iconSource, folder);
  const destDir = path.join(androidRes, folder);
  
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  files.forEach(file => {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  ✓ ${folder}/${file}`);
    }
  });
});

// Copy splash screen
const splashSrc = path.join(iconSource, 'splash.png');
const drawableDir = path.join(androidRes, 'drawable');
if (!fs.existsSync(drawableDir)) fs.mkdirSync(drawableDir, { recursive: true });
if (fs.existsSync(splashSrc)) {
  fs.copyFileSync(splashSrc, path.join(drawableDir, 'splash.png'));
  console.log('  ✓ drawable/splash.png');
}

console.log('\n✅ All icons copied to Android project!');
