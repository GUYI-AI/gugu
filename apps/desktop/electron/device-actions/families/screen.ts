import { MAC_PRIVACY, fail, ok, requestHelperPermission, type ActionFamily, type FamilyContext, type Outcome } from '../catalog'
import { NativeCallError } from '../native/mac-helper-client'

const SCREEN_MAX_EDGE = 1568
const UNSUPPORTED = 'This build of 咕咕 cannot capture the screen'

function captureFailure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error)
  return fail(error instanceof NativeCallError && error.code === 'os_permission' ? 'os_permission' : 'execution_failed', message)
}

/**
 * 看屏幕是宿主自己的能力:三个平台都用 Electron 截屏,不经过 Computer Use、不加载 CUA、不读辅助功能树(#1607)。
 * Mac 上要的是「屏幕录制」;只有人点「连接」时才向系统要,agent 平常调用只读真实状态。
 */
export function createScreenFamily(platform: NodeJS.Platform = process.platform): ActionFamily {
  const capture = (ctx: FamilyContext, maxEdge: number) => ctx.deps.captureScreen?.({ maxEdge })
  return {
    groups: [{
      id: 'screen',
      platforms: ['darwin', 'win32', 'linux'],
      iconApp: '/System/Applications/Utilities/Screenshot.app',
      ...(platform === 'darwin' ? {
        settingsUrl: MAC_PRIVACY('Privacy_ScreenCapture'),
        osPermission: '系统设置 → 隐私与安全性 → 屏幕录制 → 打开咕咕',
      } : {}),
      async probe(ctx) {
        if (!ctx.deps.captureScreen) return fail('unsupported', UNSUPPORTED)
        if (ctx.deps.platform === 'darwin') {
          const allowed = await requestHelperPermission(ctx, 'screen', '屏幕录制')
          // macOS 给了屏幕录制,往往要咕咕重启才生效。
          if (!allowed.ok) return Object.assign(allowed, { restart: true as const })
        }
        // 助手说给了不算数:真截一张小图才算连上。
        try {
          await capture(ctx, 320)
          return ok(null)
        } catch (error) {
          const outcome = captureFailure(error)
          return ctx.deps.platform === 'darwin' && !outcome.ok && outcome.code === 'os_permission'
            ? Object.assign(outcome, { restart: true as const }) : outcome
        }
      },
    }],
    actions: [{
      name: 'screen.get',
      group: 'screen',
      title: '看屏幕',
      titleEn: 'See screen',
      description: 'Take a screenshot of this computer\'s main display and return it as a picture you can see (longest edge at most 1568 px), with its actual width, height and how many displays are attached (only the main one is captured; on Linux a system portal may pick the screen). Does not use Computer Use or Accessibility; on macOS it needs Screen Recording for 咕咕 (System Settings → Privacy & Security), and returns os_permission without asking when that is missing.',
      risk: 'medium',
      confirm: 'never',
      singlePictureResult: true,
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      unsupportedReason: deps => deps.captureScreen ? null : UNSUPPORTED,
      async run(_args, ctx) {
        try {
          const shot = await capture(ctx, SCREEN_MAX_EDGE)
          if (!shot) return fail('unsupported', UNSUPPORTED)
          return ok({ width: shot.width, height: shot.height, displays: shot.displays,
            pictures: [{ label: 'screen.get screenshot', mimeType: shot.mimeType, data: shot.data }] })
        } catch (error) { return captureFailure(error) }
      },
    }],
  }
}
