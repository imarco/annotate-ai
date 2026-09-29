import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['src/embed.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outdir: 'dist',
  entryNames: 'embed',
  minify: true,
});
await mkdir('dist', { recursive: true });
await copyFile('node_modules/emoji-picker-element-data/en/emojibase/data.json', 'dist/emoji-data.json');
