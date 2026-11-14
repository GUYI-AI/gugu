#!/usr/bin/env node
// #7199 咕咕在 Mac 上要带的原生程序,放进 mac-native/<arch>/(打包时 electron-builder 拷进 Resources/mac-native):
// gugu-mac-helper —— 咕咕自己的原生助手(apps/desktop/native/mac-helper,从源码编):日历 / 提醒事项 / 通讯录 / 定位 / 文字识别 / 系统授权。
//
// 用法:node scripts/build/build-mac-native.mjs [--arch arm64|x64]   —— mac-native/<arch>/ 每次整个重建(旧产物不留)。
// 本地开发要用「这台电脑能做的事」里的日历等,先跑一次这个(在 owner 的 MBP 上请套 nice -n 15 lockf -k /tmp/gugu-heavy.lock)。
// 只在 macOS 上能编;别的平台直接报错退出(❌ 静默跳过 —— 打 Mac 包时缺了它,用户点「连接」才发现)。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

if (process.platform !== 'darwin') {
  console.error('[build-mac-native] 只能在 macOS 上编(要 Xcode 的 swift 工具链与 lipo)')
  process.exit(1)
}

const arch = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64')
if (arch !== 'arm64' && arch !== 'x64') {
  console.error(`[build-mac-native] --arch 只认 arm64 / x64,收到 ${arch}`)
  process.exit(1)
}
const machArch = arch === 'x64' ? 'x86_64' : 'arm64'
const out = path.join(root, 'mac-native', arch)
const cache = path.join(root, '.build', 'mac-native-cache')

function run(cmd, args, options = {}) {
  console.log(`[build-mac-native] $ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', ...options })
}

function swiftBuild(packagePath, scratch) {
  run('swift', ['build', '-c', 'release', '--arch', machArch, '--package-path', packagePath, '--scratch-path', scratch])
  return execFileSync('swift', ['build', '-c', 'release', '--arch', machArch, '--package-path', packagePath, '--scratch-path', scratch, '--show-bin-path'], { encoding: 'utf8' }).trim()
}

const archsOf = (file) => execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(cache, { recursive: true })

const helperBin = swiftBuild(path.join(root, 'apps/desktop/native/mac-helper'), path.join(cache, `helper-${arch}`))
fs.copyFileSync(path.join(helperBin, 'gugu-mac-helper'), path.join(out, 'gugu-mac-helper'))
fs.chmodSync(path.join(out, 'gugu-mac-helper'), 0o755)
if (!archsOf(path.join(out, 'gugu-mac-helper')).includes(machArch)) throw new Error(`[build-mac-native] gugu-mac-helper 不是 ${machArch}`)

console.log(`[build-mac-native] ✓ ${out}: gugu-mac-helper (${machArch})`)
