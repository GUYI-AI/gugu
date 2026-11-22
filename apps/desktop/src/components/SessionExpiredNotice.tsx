// @@@3898 登录失效必须说出来 —— 这是那句话在屏幕上的落点。
//
// 缺口不在「产品不知道」,而在「产品知道了却没有任何地方在读」:SessionCoordinator 早已把会话
// 健康算成 snapshot.status('degraded' = refresh 失败但仍在无限重试,user 保留),App.tsx 也把它
// 放进了 AuthContext.status —— 但整个渲染层**一个消费方都没有**,那是一条写入后从未被读取的输出。
// 于是产品继续渲染一个看起来可写的界面:会话列表照常、composer 照常、「新建 Agent」照常可点,
// 而每条数据面请求 401(owner 真机实测,#3898)。
//
// ❌ 不做整屏接管(整屏闸只配「什么都做不成」的场合;#4935 后连时钟闸也删了)。这里读还是好的,
// 票里也明说「缓存可以继续渲染历史内容」——但**不得让人以为写操作还能成**。
// ❌ 不可关闭:它陈述的是一个持续为真的事实,关掉它只会把症状盖回去。
//
// @@@4395 ❌ **不再提供「重新登录」入口**。那个按钮做的是登出,而它出现的时机恰恰是会话
// 马上要自己续上的时候 —— owner 实测:醒来看到横幅、照它说的点下去,signOut 卡在尚未就绪的网络上
// 超时,应用误判并把还能用的 refresh token 烧掉,于是「再等十秒就好」变成「必须重新登录」。
// 本横幅现在只**陈述事实**;真正失效时 coordinator 会落登录页,那条路本身已经响亮。
import { useTranslation } from 'react-i18next'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { useNotice } from '../lib/notices'
import { useSessionWriteBlocked } from '../hooks/useSessionWriteBlocked'

// 一条常驻提示,放在横幅位上(和别的常驻提示同一处、同一条规则)。不可关(dismissible:false):理由见上。
export function SessionExpiredNotice() {
  const { t } = useTranslation('main')
  const blocked = useSessionWriteBlocked()
  useNotice('session-expired', blocked ? {
    ongoing: true, dismissible: false, tier: 'warning', title: t('shell.sessionExpired.title'),
    description: <span data-testid={AUTOMATION_TEST_IDS.sessionExpiredNotice}>{t('shell.sessionExpired.description')}</span>,
  } : null)
  return null
}
