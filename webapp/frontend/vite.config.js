import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Allow the dev server to serve webapp/example_files/settings.json,
    // which App.jsx imports directly as the new-project defaults template.
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
})
