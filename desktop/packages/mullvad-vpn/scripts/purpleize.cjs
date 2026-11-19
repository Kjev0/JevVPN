// JevVPN rebrand: rotate every blue-ish color (hue 185-235) in the given files to purple,
// keeping saturation and lightness so contrast stays identical to the original design.
// Usage: node scripts/purpleize.cjs <file>...
const fs = require('fs');

const HUE_SHIFT = 60; // ~211deg (blue) -> ~271deg (purple)

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function shift(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (h < 185 || h > 235 || s < 0.08) return null;
  return hslToRgb((h + HUE_SHIFT) % 360, s, l);
}

function transform(text) {
  let out = text.replace(
    /rgb(a?)\(\s*(\d+),\s*(\d+),\s*(\d+)(\s*,\s*[\d.]+)?\s*\)/g,
    (m, a, r, g, b, alpha) => {
      const c = shift(+r, +g, +b);
      return c ? `rgb${a}(${c.join(', ')}${alpha ?? ''})` : m;
    },
  );
  out = out.replace(/#([0-9a-fA-F]{6})\b/g, (m, hex) => {
    const c = shift(
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    );
    return c ? '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase() : m;
  });
  return out;
}

module.exports = { shift, transform };

if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const before = fs.readFileSync(file, 'utf8');
    const after = transform(before);
    if (after !== before) {
      fs.writeFileSync(file, after);
      console.log('purpleized', file);
    }
  }
}
