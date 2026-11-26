import type {
  SubscriptionPlanReading,
  SubscriptionUsageWindow,
} from '@gugu/session-core/agents/plugins';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';
import { vendorName } from '@/i18n/vendorName';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

/**
 * 「订阅」页一行里的字(product spec)。纯函数:读数 → 要画的字，好钉单测。
 * 套餐名是厂商自己的叫法，经 `planText` 显示(英文界面用厂商自己的英文名);读不到的格说为什么，❌ 画成 0、❌ 猜。
 */

/** 谁在付钱 + 套餐 —— 行的第一行说明。`hasGuguModels`:这家能走咕咕积分(没登自己的账号时补一句)。 */
export function payerLine(plan: SubscriptionPlanReading, translate: Translate, hasGuguModels: boolean): string {
  switch (plan.payer) {
    case 'subscription': {
      const name = plan.plan ? planName(plan, translate) : undefined;
      return name
        ? `${translate('subscriptions.payer.subscription')}: ${name}`
        : translate('subscriptions.payer.subscription');
    }
    case 'api-key':
      return plan.plan
        ? `${translate('subscriptions.payer.apiKey')}: ${planText(plan)}`
        : translate('subscriptions.payer.apiKey');
    case 'custom-endpoint':
      return translate('subscriptions.payer.customEndpoint', { endpoint: plan.endpoint ?? '' }).trim();
    case 'not-signed-in':
      return translate(hasGuguModels ? 'subscriptions.payer.notSignedInGugu' : 'subscriptions.payer.notSignedIn');
    case 'unknown':
      return plan.message
        ? `${translate('subscriptions.payer.unknown')}:${plan.message}`
        : translate('subscriptions.payer.unknown');
  }
}

/** The plan's name as the vendor spells it in the current language; every surface that shows a plan name uses this. */
export function planText(plan: SubscriptionPlanReading): string {
  return plan.plan ? vendorName(plan.plan) : '';
}

function planName(plan: SubscriptionPlanReading, translate: Translate): string {
  return plan.tierUnknown ? translate('subscriptions.tierUnknown', { plan: planText(plan) }) : planText(plan);
}

/** 窗口的名字:按长度不按厂商的位置;厂商分了组就带上组名(原样)。 */
export function windowLabel(window: SubscriptionUsageWindow, translate: Translate): string {
  const span = windowSpan(window, translate);
  return window.group ? `${span} (${window.group})` : span;
}

function windowSpan(window: SubscriptionUsageWindow, translate: Translate): string {
  if (window.monthly) return translate('subscriptions.window.month');
  const minutes = window.windowMinutes;
  if (minutes === undefined) return translate('subscriptions.window.other');
  if (minutes === 300) return translate('subscriptions.window.fiveHour');
  if (minutes === 10_080) return translate('subscriptions.window.week');
  if (minutes % 1_440 === 0) return translate('subscriptions.window.days', { count: minutes / 1_440 });
  return translate('subscriptions.window.hours', { count: Math.round((minutes / 60) * 10) / 10 });
}

export function formatPercent(value: number): string {
  if (value > 0 && value < 1) return value.toFixed(1);
  return String(Math.round(value));
}

/** 已用到这个程度就用警示色画条(快用完了)。 */
export const NEARLY_USED_PERCENT = 90;
