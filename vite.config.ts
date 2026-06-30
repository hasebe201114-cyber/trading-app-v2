import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// アプリバージョン + git コミットをビルド時に埋め込む（取得不可なら 'unknown'。デプロイ非破壊）
let gitCommit = 'unknown'
try {
  gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch { /* git 不在環境では unknown のまま */ }

let appVersion = 'unknown'
try {
  appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version
} catch { /* 取得不可なら unknown */ }

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_DEPLOY_TIME': JSON.stringify(
      new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    ),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
})
