import { build } from 'esbuild';
await build({
  entryPoints: { login: 'src/login.jsx', ui: 'src/app.jsx' },
  outdir: 'public',
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  target: ['es2021'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
});
