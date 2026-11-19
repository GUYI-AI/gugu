import { describe, expect, it } from 'vitest';
import { agentFamilies, type ChatAgentEntry, type ChatAgentScope } from './chat-agents';
import { columnAgents, standaloneAgentAnchor } from './inner-sidebar-column';
import { followInnerSidebar, viewAnchor, type InnerSidebarAnchor, type InnerSidebarView } from './inner-sidebar-anchor';

const agents: ChatAgentEntry[] = [
  { id:'room-task', projectId:'loose', agentUserId:'mine', bornInChatId:'room', time:1, isPinned:false },
  { id:'solo', projectId:'loose', agentUserId:'solo-agent', time:1, isPinned:false },
  { id:'child', projectId:'loose', agentUserId:'child-agent', parentSessionId:'solo', time:1, isPinned:false },
  { id:'unrelated', projectId:'loose', agentUserId:'other-agent', time:1, isPinned:false },
];
const families=agentFamilies(agents);
const rows=new Map([['solo-agent',{chatId:'solo-chat',name:'Standalone',avatar:null,createdAt:null}]]);
const scope=():ChatAgentScope=>({here:(id:string)=>id==='room'});
const summaries=new Map();
const room={kind:'group' as const,chatId:'room'};
const agentOf=(id:string)=>standaloneAgentAnchor(id,families,rows);
const listed=(anchor:InnerSidebarAnchor,id:string)=>columnAgents(anchor,families,summaries,rows,scope).some(agent=>agent.id===id);

describe('phone eligibility uses the desktop inner-sidebar result',()=>{
 it.each([
  [{kind:'chat',chatId:'room',chatKind:'group'},true],
  [{kind:'chat',chatId:'dm',chatKind:'dm'},false],
  [{kind:'chat',chatId:'topic',chatKind:'topic'},false],
  [{kind:'chat',chatId:'agent-dm',chatKind:'ai'},false],
  [{kind:'other'},false],
 ] as const)('chat eligibility is exactly viewAnchor: %j',(view,visible)=>{
  const result=followInnerSidebar(null,view as InnerSidebarView,()=>false,()=>null,()=>false);
  expect(result).toEqual(viewAnchor(view as InnerSidebarView));expect(result!==null).toBe(visible);
 });
 it('keeps the room only for sessions listed in its actual desktop column',()=>{
  expect(followInnerSidebar(room,{kind:'session',sessionId:'room-task'},listed,agentOf,()=>false)).toEqual(room);
  expect(followInnerSidebar(room,{kind:'session',sessionId:'unrelated'},listed,agentOf,()=>false)).toBeNull();
  expect(columnAgents(room,families,summaries,rows,scope).map(agent=>agent.id)).toEqual(['room-task']);
 });
 it('opens the standalone anchor and lists only its children, preserving that anchor for child navigation',()=>{
  const anchor=followInnerSidebar(null,{kind:'session',sessionId:'solo'},listed,agentOf,()=>false)!;
  expect(anchor.kind).toBe('agent');
  expect(columnAgents(anchor,families,summaries,rows,scope).map(agent=>agent.id)).toEqual(['child']);
  expect(followInnerSidebar(anchor,{kind:'session',sessionId:'child'},listed,agentOf,()=>false)).toEqual(anchor);
  expect(standaloneAgentAnchor('child',families,rows)).toBeNull();
 });
});
