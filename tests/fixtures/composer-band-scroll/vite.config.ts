import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import solid from 'vite-plugin-solid'
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin'
import { emdashAliasEntries } from '../../../apps/desktop/electron/sessionpage/emdash-aliases.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [vanillaExtractPlugin(), solid({ include: ['**/packages/session-chat-ui/**'] })],
  resolve: { alias: [...emdashAliasEntries.map(([find, replacement]) => ({ find, replacement })),
    { find: '@', replacement: `${repository}apps/desktop/src` }] },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:9'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('unused-layout-fixture'),
  },
  server: { host: '127.0.0.1', fs: { allow: [repository] } },
  build: { target: 'es2022', emptyOutDir: true },
})
