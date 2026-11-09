import { fail, ok, type ActionFamily } from '../catalog'

/** The existing screen grant also covers capture; legacy AX actions and Connect stay in computer.ts. */
export function createScreenCaptureFamily(): ActionFamily {
  return {
    groups: [],
    actions: [{
      name: 'screen.capture',
      group: 'screen',
      title: '截取屏幕',
      titleEn: 'Capture screen',
      description: 'Capture this computer\'s screen with Electron and return a picture (longest edge at most 1568 px), with its actual width, height and display count. Uses the primary display when identified; a Linux portal may supply one system-selected screen. Requires the existing screen grant and, on macOS, Screen Recording permission. Does not use Computer Use or Accessibility. Missing permission returns immediately without requesting it; allow Screen Recording for 咕咕 in System Settings → Privacy & Security, then retry after any required restart.',
      risk: 'medium',
      confirm: 'never',
      osPermissionScope: 'action',
      singlePictureResult: true,
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      unsupportedReason: deps => deps.captureScreenNative ? null : 'This build of 咕咕 cannot capture the screen with Electron',
      async run(_args, ctx) {
        if (!ctx.deps.captureScreenNative) return fail('unsupported', 'This build of 咕咕 cannot capture the screen with Electron')
        const shot = await ctx.deps.captureScreenNative({ maxEdge: 1568 })
        return ok({ width: shot.width, height: shot.height, displays: shot.displays,
          pictures: [{ label: 'screen.capture screenshot', mimeType: shot.mimeType, data: shot.data }] })
      },
    }],
  }
}
