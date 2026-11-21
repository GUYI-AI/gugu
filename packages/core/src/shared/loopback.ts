/** Literal loopback admission, independent of DNS, proxy settings or fake-IP routing. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1'
    || (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized) && normalized.split('.').every(part => Number(part) <= 255))
}
