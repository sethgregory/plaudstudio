const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const electronDist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const oldApp = path.join(electronDist, 'Electron.app');
const newApp = path.join(electronDist, 'Plaud Studio.app');
const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
const iconSrc = path.join(__dirname, '..', 'assets', 'icon.icns');

try {
  if (fs.existsSync(oldApp) && !fs.existsSync(newApp)) {
    fs.renameSync(oldApp, newApp);
  }

  if (fs.existsSync(newApp)) {
    fs.writeFileSync(pathTxt, 'Plaud Studio.app/Contents/MacOS/Electron');
    const infoPlist = path.join(newApp, 'Contents', 'Info.plist');
    if (fs.existsSync(infoPlist)) {
      try {
        execSync(`plutil -replace CFBundleDisplayName -string "Plaud Studio" "${infoPlist}"`, { stdio: 'ignore' });
        execSync(`plutil -replace CFBundleName -string "Plaud Studio" "${infoPlist}"`, { stdio: 'ignore' });
      } catch (_) {}
    }
    const icnsDest = path.join(newApp, 'Contents', 'Resources', 'electron.icns');
    if (fs.existsSync(iconSrc)) {
      try {
        fs.copyFileSync(iconSrc, icnsDest);
      } catch (_) {}
    }
    // Register with LaunchServices
    try {
      execSync(`touch "${newApp}" && /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${newApp}"`, { stdio: 'ignore' });
    } catch (_) {}
  }
} catch (err) {
  // Silent fallback so builds never fail
}
