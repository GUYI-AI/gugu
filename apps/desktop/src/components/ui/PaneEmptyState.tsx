// 面板空状态的统一形态：54×54 透明图标槽 + 说明文字（可选第二行引导）。
// 尺寸一律取 tokens 刻度：原先圆角 16px、字号裸写 13/11，都绕开了 --radius-*/--font-*，
// 而这组件是五处面板共用的，一处漂移就是全 app 漂移。
// 消息侧栏 / 聊天主面板 / 通讯录右栏共用——改样式只改这里。
// icon 可省(#6264 设置 → 设备):design.md 的 Reject 列表点名「icons dropped into tinted tiles」,
// 新调用点不带图标,只留说明文字;存量调用点照旧。
// art:页面级的大空白(加联系人、加群、新请求、没找到)放一张墨线插画(ui/Illustration),不进图标槽;
// 这时 caption 升为标题、hint 是正文一句,下面接一个出口(action)。
export function PaneEmptyState({ icon, art, caption, hint, action, phone = false }: {
  icon?: React.ReactNode; art?: React.ReactNode; caption: string; hint?: string; action?: React.ReactNode; phone?: boolean
}) {
  if (art) return (
    <div className="flex flex-col items-center gap-2 text-center">
      {art}
      <div className="mt-3 text-[length:var(--font-title)] font-semibold leading-[var(--lh-body)] text-[var(--text-primary)]">{caption}</div>
      {hint && <div className="max-w-[420px] text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]">{hint}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-3">{action}</div>}
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
      {icon && (
        <div aria-hidden style={phone
          ? { width: 56, height: 56, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-capsule)', background: 'var(--muted)', color: 'var(--text-secondary)', marginBottom: 8 }
          : { width: 54, height: 54, display: 'grid', placeItems: 'center' }}>
          {icon}
        </div>
      )}
      <div style={phone
        ? { fontSize: 'var(--font-title)', color: 'var(--text-primary)', fontWeight: 'var(--font-weight-medium)' }
        : { fontSize: 'var(--font-body)', color: 'var(--text-secondary)' }}>{caption}</div>
      {hint && <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)' }}>{hint}</div>}
      {action}
    </div>
  )
}
