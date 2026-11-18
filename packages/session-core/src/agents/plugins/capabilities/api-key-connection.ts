/** Endpoint normalization for reading released connection metadata. */
type OfficialEndpoint = { officialEndpoint?: string };

/** 地址比较:去掉结尾的 `/`,协议与主机不分大小写(`https://API.openai.com/v1/` 就是官方那一个)。 */
function sameEndpoint(a: string, b: string): boolean {
  const normal = (value: string) => {
    const trimmed = value.trim().replace(/\/+$/, '');
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return trimmed.toLowerCase();
    }
  };
  return normal(a) === normal(b);
}

/**
 * 一把连接**记下来**的地址:空着、或就是这家的官方地址 ⇒ 不记(undefined = 官方)。
 * 「官方」于是只有一种写法,付款方、连接那一行、用量都照「没有地址」读作官方,❌ 读成「自定义服务」。
 * 读旧数据时也过一遍:修改前存进去的官方地址照样读作官方。
 */
export function apiKeyConnectionEndpoint(
  fields: OfficialEndpoint,
  endpoint: string | undefined
): string | undefined {
  const value = endpoint?.trim().replace(/\/+$/, '');
  if (!value) return undefined;
  if (fields.officialEndpoint && sameEndpoint(value, fields.officialEndpoint)) return undefined;
  return value;
}
