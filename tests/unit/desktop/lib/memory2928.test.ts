// #2928 Product paths: assistant memory publisher, note deletion, and home restore.
import { expect, it } from 'vitest';
import { readFrontmatter, parseMemoryNote, memoryIndexHints, removeIndexEntry } from '@gugu/core/shared/assistantMemory';
import { withOwnerProfileIndex } from '@gugu/core/shared/assistantPolicy';
import { NEUTRAL_ASSISTANT_RULES as rules } from '../assistantRules/neutralRules';

it('reads memory frontmatter inline comments',()=>{const note=parseMemoryNote('note.md','---\nname: "Plan #1" # label\ntype: project # category\ndescription: see https://example.test/#part\n---\nBody');expect(note.title).toBe('Plan #1');expect(note.kind).toBe('project');expect(note.description).toBe('see https://example.test/#part');expect(readFrontmatter("---\nname: 'Ada''s # plan' # note\n---\nBody").fields.name).toBe("Ada's # plan");});

it('decodes quoted memory metadata escapes',()=>{expect(readFrontmatter('---\nname: "Plan\\u0020A"\ndescription: "line\\nnext\\tstep"\n---\nBody').fields).toEqual({name:'Plan A',description:'line\nnext\tstep'});});

it('ignores fenced headings in memory titles',()=>{expect(parseMemoryNote('note.md','~~~md\n# Example\n~~~\n# Actual title').title).toBe('Actual title');expect(parseMemoryNote('note.md','````md\n# Example\n```\n# Still example\n````\n## Actual').title).toBe('Actual');});

it('reads memory index links with titles',()=>{expect(memoryIndexHints('# 项目\n- [Plan](./plan.md "Details")').get('plan.md')).toEqual({title:'Plan',kind:'project'});expect(memoryIndexHints("[Plan](plan.md 'Details')").has('plan.md')).toBe(true);});

it('reads angle memory index destinations',()=>{expect(memoryIndexHints('[Plan](<./my plan.md> "Details")').get('my plan.md')).toEqual({title:'Plan'});expect(memoryIndexHints('[Other](<nested/note.md>)').size).toBe(0);});

it('decodes memory index filenames once',()=>{expect(memoryIndexHints('[茶](tea%20notes.md)').get('tea notes.md')).toEqual({title:'茶'});expect(memoryIndexHints('[Literal](literal%2520.md)').has('literal%20.md')).toBe(true);expect(memoryIndexHints('[Nested](nested%2Fnote.md)').size).toBe(0);expect(memoryIndexHints('[Bad](bad%ZZ.md)').size).toBe(0);});
