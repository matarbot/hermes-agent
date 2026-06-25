/**
 * Post-build script — copies Vite output (dist/) into www/ so
 * `cap sync` can sync it to native platforms.
 *
 * Usage:  node scripts/post-build.cjs
 *
 * This is invoked by the `build` script in package.json.
 */

const fs = require('fs')
const path = require('path')
const { cpSync } = fs

const distDir = path.join(__dirname, '..', 'dist')
const wwwDir = path.join(__dirname, '..', 'www')

if (!fs.existsSync(distDir)) {
  console.error('dist/ does not exist — run `vite build` first.')
  process.exit(1)
}

fs.rmSync(wwwDir, { recursive: true, force: true })
cpSync(distDir, wwwDir, { recursive: true })

console.log('Synced dist/ → www/')
