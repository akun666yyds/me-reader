const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const SRC = process.argv[2];
const OUT_DIR = path.join(__dirname, '..', 'assets');
const RATIO = 0.22;

function roundedMaskSvg(size) {
  const r = Math.round(size * RATIO);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>` +
    `</svg>`
  );
}

async function roundCorners(input, size) {
  const base = await sharp(input)
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const mask = await sharp(roundedMaskSvg(size))
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer();

  for (let i = 0; i < size * size; i++) {
    base[i * 4 + 3] = mask[i * 4 + 3];
  }

  return sharp(base, { raw: { channels: 4, width: size, height: size } }).png().toBuffer();
}

async function main() {
  if (!SRC || !fs.existsSync(SRC)) {
    console.error('Usage: node scripts/build-icon.js <source-image>');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const png512 = await roundCorners(SRC, 512);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

  const png256 = await roundCorners(png512, 256);
  const ico = png2icons.createICO(png256, png2icons.BEZIER, -1, true, true);
  if (!ico) throw new Error('createICO failed: ' + png2icons.error);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  console.log('icons written to assets/ (icon.png, icon.ico)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
