/**
 * Generate default feathered circle sprite for particle system.
 * Creates a 256x256 PNG with white center fading to transparent edges.
 */

const sharp = require('sharp');
const path = require('path');

const SIZE = 256;
const CENTER = SIZE / 2;

async function generateFeatheredCircle() {
  // Create raw RGBA pixel data
  const pixels = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CENTER;
      const dy = y - CENTER;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const normalizedDistance = distance / CENTER;

      // Feathered falloff - white in center, transparent at edges
      // Using smoothstep-like curve for soft falloff
      let alpha;
      if (normalizedDistance >= 1.0) {
        alpha = 0;
      } else {
        // Soft falloff curve
        const t = 1.0 - normalizedDistance;
        alpha = Math.pow(t, 1.5) * 255; // Power curve for softer edges
      }

      const idx = (y * SIZE + x) * 4;
      pixels[idx] = 255;     // R - white
      pixels[idx + 1] = 255; // G - white
      pixels[idx + 2] = 255; // B - white
      pixels[idx + 3] = Math.round(alpha); // A - feathered
    }
  }

  const outputPath = path.join(__dirname, '..', 'assets', 'sprites', 'default-particle.png');

  await sharp(pixels, {
    raw: {
      width: SIZE,
      height: SIZE,
      channels: 4
    }
  })
    .png()
    .toFile(outputPath);

  console.log(`Generated: ${outputPath}`);
  return outputPath;
}

generateFeatheredCircle().catch(console.error);
