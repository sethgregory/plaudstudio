const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Read the high-res cropped Plaud emblem
const emblemPath = path.join(__dirname, '..', 'assets', 'emblem.png');
let emblemBase64 = '';
if (fs.existsSync(emblemPath)) {
  emblemBase64 = fs.readFileSync(emblemPath).toString('base64');
}

const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1024px;
      height: 1024px;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
    }

    /* Apple macOS HIG squircle canvas: 824x824 at 1024x1024 canvas */
    .squircle {
      width: 824px;
      height: 824px;
      border-radius: 185px;
      background: linear-gradient(180deg, #131b2e 0%, #0d1322 55%, #080c16 100%);
      box-shadow: 
        0 42px 84px rgba(0, 0, 0, 0.7),
        0 14px 28px rgba(0, 0, 0, 0.5),
        inset 0 1.5px 2px rgba(255, 255, 255, 0.28),
        inset 0 0 0 1.5px rgba(255, 255, 255, 0.08),
        inset 0 -2px 4px rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
    }

    /* Subtle background grid pattern representing studio acoustic precision */
    .studio-grid {
      position: absolute;
      inset: 0;
      background-image: 
        radial-gradient(circle at center, rgba(56, 189, 248, 0.04) 1px, transparent 1px);
      background-size: 28px 28px;
      background-position: center center;
      opacity: 0.6;
      pointer-events: none;
    }

    /* Subtle concentric audio aperture rings in background */
    .aperture-ring {
      position: absolute;
      border-radius: 50%;
      border: 1px solid rgba(56, 189, 248, 0.07);
      pointer-events: none;
    }
    .ring-1 { width: 540px; height: 540px; }
    .ring-2 { width: 680px; height: 680px; border-color: rgba(99, 102, 241, 0.05); }

    /* Luminous Studio Aurora Glow behind the emblem */
    .glow {
      position: absolute;
      width: 480px;
      height: 480px;
      border-radius: 50%;
      background: radial-gradient(circle, 
        rgba(56, 189, 248, 0.32) 0%, 
        rgba(99, 102, 241, 0.22) 40%, 
        rgba(168, 85, 247, 0.12) 65%, 
        transparent 80%);
      filter: blur(48px);
      z-index: 1;
    }

    /* Studio Soundwave Acoustic Arcs */
    .soundwaves {
      position: absolute;
      width: 720px;
      height: 440px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 2;
      pointer-events: none;
    }

    .wave-group {
      display: flex;
      align-items: center;
      height: 100%;
    }

    /* Center Emblem Container */
    .emblem-wrapper {
      position: relative;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* The Heroic Plaud Arch & Dot */
    .plaud-symbol {
      width: 430px;
      height: 363px;
      background: linear-gradient(145deg, 
        #f0f9ff 0%, 
        #7dd3fc 15%, 
        #38bdf8 38%, 
        #6366f1 70%, 
        #a855f7 100%);
      -webkit-mask-image: url('data:image/png;base64,${emblemBase64}');
      -webkit-mask-size: contain;
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      filter: drop-shadow(0 24px 38px rgba(56, 189, 248, 0.42)) 
              drop-shadow(0 8px 16px rgba(0, 0, 0, 0.6));
      position: relative;
    }

    /* Additional luminous core highlight for the central recording dot */
    .recording-core {
      position: absolute;
      /* exact center of dot: x=49.85%, y=57.28%, radius=38/295*363 ≈ 47px */
      width: 104px;
      height: 104px;
      top: calc(57.28% - 52px);
      left: calc(49.85% - 52px);
      border-radius: 50%;
      background: radial-gradient(circle, 
        #ffffff 0%, 
        #bae6fd 25%, 
        rgba(56, 189, 248, 0.95) 55%, 
        rgba(99, 102, 241, 0.4) 80%,
        transparent 100%);
      box-shadow: 
        0 0 24px rgba(56, 189, 248, 0.8),
        0 0 45px rgba(99, 102, 241, 0.5);
      z-index: 4;
      pointer-events: none;
    }

    /* Acoustic pulse halo around the recording core */
    .recording-halo {
      position: absolute;
      width: 136px;
      height: 136px;
      top: calc(57.28% - 68px);
      left: calc(49.85% - 68px);
      border-radius: 50%;
      border: 1.5px solid rgba(56, 189, 248, 0.45);
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.3);
      z-index: 3;
      pointer-events: none;
    }

    /* Glass specular surface reflection across the top of the squircle */
    .specular-sheen {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 380px;
      background: linear-gradient(180deg, 
        rgba(255, 255, 255, 0.08) 0%, 
        rgba(255, 255, 255, 0.02) 60%, 
        transparent 100%);
      border-top-left-radius: 185px;
      border-top-right-radius: 185px;
      pointer-events: none;
      z-index: 5;
    }
  </style>
</head>
<body>
  <div class="squircle">
    <div class="specular-sheen"></div>
    <div class="studio-grid"></div>
    <div class="aperture-ring ring-1"></div>
    <div class="aperture-ring ring-2"></div>
    <div class="glow"></div>

    <!-- Acoustic Sound Wave arcs flanking the emblem -->
    <div class="soundwaves">
      <svg width="110" height="280" viewBox="0 0 110 280" fill="none">
        <defs>
          <linearGradient id="waveLeft" x1="100%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#818cf8" stop-opacity="0.3" />
          </linearGradient>
        </defs>
        <!-- Outer arc -->
        <path d="M95 30 C 40 85, 40 195, 95 250" stroke="url(#waveLeft)" stroke-width="7" stroke-linecap="round" opacity="0.35" />
        <!-- Middle arc -->
        <path d="M100 65 C 62 105, 62 175, 100 215" stroke="url(#waveLeft)" stroke-width="8" stroke-linecap="round" opacity="0.65" />
        <!-- Inner arc -->
        <path d="M105 100 C 85 120, 85 160, 105 180" stroke="url(#waveLeft)" stroke-width="9" stroke-linecap="round" opacity="0.9" />
      </svg>

      <svg width="110" height="280" viewBox="0 0 110 280" fill="none">
        <defs>
          <linearGradient id="waveRight" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#c084fc" stop-opacity="0.3" />
          </linearGradient>
        </defs>
        <!-- Inner arc -->
        <path d="M5 100 C 25 120, 25 160, 5 180" stroke="url(#waveRight)" stroke-width="9" stroke-linecap="round" opacity="0.9" />
        <!-- Middle arc -->
        <path d="M10 65 C 48 105, 48 175, 10 215" stroke="url(#waveRight)" stroke-width="8" stroke-linecap="round" opacity="0.65" />
        <!-- Outer arc -->
        <path d="M15 30 C 70 85, 70 195, 15 250" stroke="url(#waveRight)" stroke-width="7" stroke-linecap="round" opacity="0.35" />
      </svg>
    </div>

    <!-- The Plaud Studio Heroic Emblem -->
    <div class="emblem-wrapper">
      <div class="recording-halo"></div>
      <div class="recording-core"></div>
      <div class="plaud-symbol"></div>
    </div>
  </div>
</body>
</html>
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true }
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
  // Small pause for fonts & shadows
  await new Promise((r) => setTimeout(r, 450));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const assetsDir = path.join(__dirname, '..', 'assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  const pngPath = path.join(assetsDir, 'icon.png');
  fs.writeFileSync(pngPath, image.toPNG());
  console.log(`Saved 1024x1024 PNG to ${pngPath}`);

  // Also save to public/favicon.png for web browser interface
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    const faviconPath = path.join(publicDir, 'favicon.png');
    execSync(`sips -z 128 128 "${pngPath}" --out "${faviconPath}"`, { stdio: 'ignore' });
    console.log(`Updated web favicon at ${faviconPath}`);
  }

  // Generate .icns using iconutil
  const iconsetDir = path.join(assetsDir, 'icon.iconset');
  if (fs.existsSync(iconsetDir)) fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir);

  const sizes = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' }
  ];

  for (const s of sizes) {
    const dest = path.join(iconsetDir, s.name);
    execSync(`sips -z ${s.size} ${s.size} "${pngPath}" --out "${dest}"`, { stdio: 'ignore' });
  }

  const icnsPath = path.join(assetsDir, 'icon.icns');
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
  console.log(`Generated native macOS icns to ${icnsPath}`);
  fs.rmSync(iconsetDir, { recursive: true, force: true });

  app.quit();
});
