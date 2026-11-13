import { expect, it } from 'vitest'
import { parseServerUpdateState, parseServerRollback } from '@gugu/core/cloud/deviceHostInfo'
import { baselineStatus, readHealthSummary } from '@gugu/core/shared/healthSummary'
import { isModelAccessProtocol, normalizeAgentModelSelection } from '@gugu/core/shared/agentModelSelection'
const summary = () => ({ v: 1, timezone: 'Asia/Hong_Kong', generated_at: '2026-11-13T00:00:00Z', range: { start_date: '2026-11-01', end_date: '2026-11-13' }, background: { supported: true, granted: true }, granted_types: [], missing_types: [], days: [], signals: [], workouts: [], last_night: null, body: {}, unreadable: [] })

it('treats JSON null update state as unavailable', () => { expect(parseServerUpdateState('null', 1000)).toBeNull() })
