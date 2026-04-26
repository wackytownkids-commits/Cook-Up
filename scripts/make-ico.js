// Regenerate build/icon.ico from build/icon.png with all standard
// Windows sizes. Run with: node scripts/make-ico.js
//
// png-to-ico's default behavior with a single PNG is to embed only
// that one size, so we pass an explicit size array.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pngToIco = require('png-to-ico').default;

const ROOT = path.join(__dirname, '..');
const TMP  = path.join(ROOT, 'build', '.icon-tmp');
const OUT  = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  // Step 1: resize source PNG to each Windows-standard size via PowerShell.
  execFileSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'resize-icon.ps1')],
    { stdio: 'inherit' }
  );

  // Step 2: pack each PNG into a single multi-resolution .ico.
  const buffers = SIZES.map((s) => fs.readFileSync(path.join(TMP, `${s}.png`)));
  const ico = await pngToIco(buffers);
  fs.writeFileSync(OUT, ico);
  console.log('Wrote', OUT, '(' + ico.length + ' bytes)');

  // Cleanup tmp dir.
  for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
  fs.rmdirSync(TMP);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
