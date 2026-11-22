import tls from 'node:tls'

export function bundledCaPem(): string { return `${tls.rootCertificates.join('\n')}\n` }

export function installSystemCertificates(): void {
  tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])])
}
