import { expect, it } from 'vitest'
import { creationFailureDiagnostic } from './create-failure-diagnostic'

it('retains fixed refusal codes without copying arbitrary host diagnostics', () => {
  expect(creationFailureDiagnostic('attachment_creation_unverified')).toEqual({ code: 'attachment_creation_unverified' })
  expect(creationFailureDiagnostic('EACCES')).toEqual({ code: 'EACCES' })
  for (const code of [null, '/Users/private-owner/files/secret.txt', 'secret-token', '__proto__', 'constructor']) {
    expect(creationFailureDiagnostic(code)).toEqual({ code: 'unknown_creation_failure' })
  }
})
