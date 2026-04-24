const fs = require('fs');
const path = require('path');
const svg2img = require('svg2img');
const toIco = require('to-ico');

const buildDir = path.join(__dirname, '..', 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');

// Read SVG
const svgContent = fs.readFileSync(svgPath, 'utf8');

// Convert to PNG
svg2img(svgContent, { width: 256, height: 256 }, (error, buffer) => {
  if (error) {
    console.error('SVG to PNG failed:', error);
    process.exit(1);
  }

  // Save PNG
  fs.writeFileSync(pngPath, buffer);
  console.log('Created:', pngPath);

  // Convert to ICO (multiple sizes)
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = [];
  let completed = 0;

  sizes.forEach(size => {
    svg2img(svgContent, { width: size, height: size }, (err, buf) => {
      if (err) {
        console.error(`Failed to create ${size}x${size}:`, err);
        return;
      }
      pngBuffers.push(buf);
      completed++;

      if (completed === sizes.length) {
        toIco(pngBuffers).then(ico => {
          fs.writeFileSync(icoPath, ico);
          console.log('Created:', icoPath);
        }).catch(e => {
          console.error('ICO creation failed:', e);
        });
      }
    });
  });
});
