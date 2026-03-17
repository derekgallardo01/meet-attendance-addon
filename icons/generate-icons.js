const { execSync } = require('child_process');
const path = require('path');

// Install sharp if not available
try {
  require.resolve('sharp');
} catch {
  console.log('Installing sharp...');
  execSync('npm install sharp', { cwd: __dirname, stdio: 'inherit' });
}

const sharp = require('sharp');
const fs = require('fs');

const svgPath = path.join(__dirname, 'icon.svg');
const svgBuffer = fs.readFileSync(svgPath);

const sizes = [128, 96, 48, 32];

async function generate() {
  for (const size of sizes) {
    const outPath = path.join(__dirname, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`Created ${outPath}`);
  }
}

generate().catch(console.error);
