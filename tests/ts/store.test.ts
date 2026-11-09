import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as s from '../../scripts/lib/store';
import { BoardError, Conflict } from '../../scripts/lib/types';

function fixture(fn: (root:string)=>void) { const root=mkdtempSync(join(tmpdir(),'ab-ts-')); try { s.init(root); fn(root); } finally { rmSync(root,{recursive:true,force:true}); } }
describe('store',()=>{
 test('lifecycle, stale revision/hash, and claims',()=>fixture(root=>{ const x=s.create(root,{title:'Task'}); const y=s.update(root,x.id,1,{assignee:'alpha'}); expect(y.revision).toBe(2); expect(()=>s.update(root,x.id,1,{title:'stale'})).toThrow(Conflict); expect(()=>s.update(root,x.id,null,{assignee:'beta'},{claim:true})).toThrow('Already claimed by alpha'); expect(()=>s.update(root,x.id,2,{title:'hash'},{expectedHash:'0'.repeat(64)})).toThrow('Item file changed since it was read'); expect(s.get(root,x.id).title).toBe('Task'); }));
 test('validation and exact messages',()=>fixture(root=>{ for(const v of [{title:' '},{title:'x',status:'bad'}]) expect(()=>s.create(root,v as any)).toThrow(BoardError); expect(()=>s.create(root,{title:'x',wat:1} as any)).toThrow('Unknown item fields: wat'); expect(()=>s.update(root,'bad',null,{title:'x'})).toThrow('Invalid item ID'); }));
 test('snapshot order and invalid filename',()=>fixture(root=>{ const a=s.create(root,{title:'a'}), b=s.create(root,{title:'b'}); expect(s.snapshot(root).items.map(x=>x.id)).toEqual([a.id,b.id].sort()); writeFileSync(join(root,'.agentboard','items','bad.json'),'{}'); expect(()=>s.snapshot(root)).toThrow('Invalid item filename: bad.json'); }));
 test('init exclude and duplicate init',()=>{ const root=mkdtempSync(join(tmpdir(),'ab-ts-')); try { mkdirSync(join(root,'.git','info'),{recursive:true}); writeFileSync(join(root,'.git','info','exclude'),'existing'); s.init(root); expect(readFileSync(join(root,'.git','info','exclude'),'utf8')).toBe('existing\n/.agentboard.lock\n'); expect(()=>s.init(root)).toThrow('Board already exists'); } finally {rmSync(root,{recursive:true,force:true});} });
 test('encode produces exact bytes (2-space JSON, raw non-ASCII, trailing newline)',()=>{
  const cases: [unknown,string][]=[
   [{z:'\u0001 " \\ 😀 漢字 </script> ',a:[],n:null}, '{\n  "z": "\\u0001 \\" \\\\ 😀 漢字 </script> ",\n  "a": [],\n  "n": null\n}\n'],
   [{nested:{q:'line\n\t\r'}}, '{\n  "nested": {\n    "q": "line\\n\\t\\r"\n  }\n}\n'],
   [{list:[1,'a',[],{}]}, '{\n  "list": [\n    1,\n    "a",\n    [],\n    {}\n  ]\n}\n'],
   [{e:''}, '{\n  "e": ""\n}\n'],
  ];
  for(const [value,expected] of cases) expect(Buffer.from(s.encode(value)).toString('utf8')).toBe(expected);
  expect([...Buffer.from(s.encode({k:'漢😀'}))]).toEqual([...Buffer.from('{\n  "k": "'),0xe6,0xbc,0xa2,0xf0,0x9f,0x98,0x80,...Buffer.from('"\n}\n')]);
 });
});

