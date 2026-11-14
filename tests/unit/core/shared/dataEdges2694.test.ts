import { expect, it } from 'vitest'
import { resourceRejection, folderNameProblem } from '@gugu/core/shared/assistantResourceRules'
import { linuxNameFromOsRelease, parseServerRollback } from '@gugu/core/cloud/deviceHostInfo'
import { readHealthSummary } from '@gugu/core/shared/healthSummary'
import { panelApplicationFailure } from '@gugu/core/shared/assistantPanelFailure'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { opensAsStoredText } from '@gugu/core/shared/workspaceUpload.mjs'
const summary = () => ({ v:1,timezone:'UTC',generated_at:'',range:{start_date:'',end_date:''},background:{supported:true,granted:true},body:{},days:[],signals:[],workouts:[],last_night:null,granted_types:[],missing_types:[],unreadable:[] })

it('rejects case-insensitive audio and video resource MIME', () => { expect(resourceRejection({ name:'unknown', size:1, type:' Audio/ogg; codecs=opus ' })).toBe('unsupported'); expect(resourceRejection({ name:'unknown', size:1, type:'Video/MP4' })).toBe('unsupported') })

it('rejects backslashes in single-segment resource folder names', () => { expect(folderNameProblem('parent\\child')).toBe('slash'); expect(folderNameProblem('notes')).toBeNull() })

it('decodes escaped quotes in os-release pretty names', () => { expect(linuxNameFromOsRelease("PRETTY_NAME=\"Example \\\"OS\\\"\"")).toBe('Example "OS"') })

it('omits rollback records with nonfinite timestamps', () => { expect(parseServerRollback('{"version":"bad","restored":"good","at":1e400}', 1000, 'good')).toBeNull() })

it('reports malformed health background booleans', () => { expect(readHealthSummary({...summary(),background:{supported:'yes',granted:true}})).toEqual({ok:false,problem:'background.supported'}); expect(readHealthSummary({...summary(),background:{supported:true,granted:1}})).toEqual({ok:false,problem:'background.granted'}) })

it('uses generic panel text for inherited category and error names', () => { const actual=panelApplicationFailure('constructor','item','constructor','en-US'); expect(actual).toContain('Panel resource'); expect(actual).toContain('The resource update could not complete'); expect(actual).not.toContain('undefined') })
