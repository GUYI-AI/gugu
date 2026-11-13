import { expect, it } from 'vitest'
import { parseServerUpdateState, parseServerRollback } from '@gugu/core/cloud/deviceHostInfo'
import { baselineStatus, readHealthSummary } from '@gugu/core/shared/healthSummary'
import { isModelAccessProtocol, normalizeAgentModelSelection } from '@gugu/core/shared/agentModelSelection'
const summary = () => ({ v: 1, timezone: 'Asia/Hong_Kong', generated_at: '2026-11-13T00:00:00Z', range: { start_date: '2026-11-01', end_date: '2026-11-13' }, background: { supported: true, granted: true }, granted_types: [], missing_types: [], days: [], signals: [], workouts: [], last_night: null, body: {}, unreadable: [] })

it('treats JSON null update state as unavailable', () => { expect(parseServerUpdateState('null', 1000)).toBeNull() })

it('treats JSON null rollback state as unavailable', () => { expect(parseServerRollback('null', 1000, '1.0.0')).toBeNull() })

it('keeps old measurements outside the health baseline window', () => { expect(baselineStatus('sleep', 400, [600, 600, 600, ...Array(14).fill(null)])).toEqual({ baseline: null, status: null }); expect(baselineStatus('sleep', 400, [600, ...Array(11).fill(null), 400, 400, 400]).baseline).toBe(400) })

it('reports nonfinite body readings at their field', () => { for (const value of [NaN, Infinity, -Infinity]) expect(readHealthSummary({ ...summary(), body: { weight_kg: { value, at: '2026-11-13' } } })).toEqual({ ok: false, problem: 'body.weight_kg' }) })
