import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { search, loadRecords } from '../src/engine.mjs';
import { expandContext, contextRange, contextSchema } from '../src/context.mjs';
import { createCounter, summarize } from '../src/metrics.mjs';
import { auditRecords } from '../src/audit.mjs';

const counter = createCounter();
test.after(() => counter.free());
const content = ['extends Node', '', 'func navigate():', '\tvar target = "needle"',
  '\tif target:', '\t\treturn "MISSED_BRANCH"', '', 'func unrelated():', '\treturn "OTHER_FUNCTION"', ''].join('\n');
const yes = async () => ({ ok: true, status: 200, json: async () => ({ model: 'test', usage: {input_tokens:1,output_tokens:1},
  answers:{relevance:{type:'choice',choice:'Yes',confidence:1,probabilities:{Yes:1,No:0}}} }) });
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-context-expand-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'unit.gd'), content);
  const config = { root, dataDir: path.join(root, '.jev-context'), key: 'test-key', ...options };
  const result = await search({ question:'How does navigation work?',query:'needle',context_lines:0 },config,{counter,fetchImpl:yes});
  assert.equal(result.isError,false);
  const candidate=JSON.parse(result.payload).results[0];
  return { config, result, args: {retrieval_id:result.record.id,candidate_id:candidate.id,repository_root:root} };
}

test('function expansion recovers omitted branches without another relevance judgment', async () => {
  const {config,result,args}=await fixture();
  const expanded=await expandContext(args,{...config,key:undefined},{counter});
  assert.equal(expanded.isError,false);
  const payload=JSON.parse(expanded.payload), context=payload.results[0];
  assert.equal(context.selection,'function');
  assert.equal(context.truncated,false);
  assert.equal(context.start_line,3); assert.equal(context.end_line,6);
  assert.match(context.text,/MISSED_BRANCH/); assert.doesNotMatch(context.text,/OTHER_FUNCTION/);
  assert.equal(context.yes_probability,undefined);
  assert.equal(context.original_passage_unchanged,true);
  assert.equal(expanded.record.jev.calls,0);
  assert.equal(payload.token_savings.saved_tokens,-counter.count(expanded.payload));
  assert.match(payload.token_savings.footer,/local context expansion/);
  const records=await loadRecords(config.dataDir);
  assert.equal((await auditRecords(config.dataDir,records)).all_successful_runs_verified,true);
  const group=summarize(records).groups.find(g=>g.operation==='expand_context');
  assert.equal(group.weighted_reduction_pct,null);
  assert.equal(group.actual_vs_baseline_tokens_saved,-counter.count(expanded.payload));
  await writeFile(path.join(expanded.directory,'actual.txt'),expanded.payload+' ');
  assert.equal((await auditRecords(config.dataDir,[result.record,expanded.record])).all_successful_runs_verified,false);
});

test('surrounding mode returns neighboring functions and counts repeated response overhead', async () => {
  const {config,args}=await fixture({includeReceipts:false});
  const expanded=await expandContext({...args,mode:'surrounding',before_lines:2,after_lines:5},config,{counter});
  assert.equal(expanded.isError,false);
  const payload=JSON.parse(expanded.payload);
  assert.match(payload.results[0].text,/OTHER_FUNCTION/);
  assert.equal(payload.token_savings,undefined);
  assert.equal(expanded.record.metrics.actual_response_tokens,counter.count(expanded.payload));
  assert.equal((await auditRecords(config.dataDir,[expanded.record])).all_successful_runs_verified,true);
});

test('changed saved passage, unavailable files, wrong root and invalid anchors fail without source', async () => {
  const {config,args}=await fixture();
  for(const extra of [{candidate_id:'unknown'},{repository_root:os.tmpdir()},{anchor_line:100}]) {
    const e=await expandContext({...args,...extra},config,{counter}); assert.equal(e.isError,true);assert.doesNotMatch(e.payload,/MISSED_BRANCH/);
  }
  await writeFile(path.join(config.root,'src/unit.gd'),content.replace('needle','changed'));
  const stale=await expandContext(args,config,{counter}); assert.equal(stale.isError,true);assert.match(stale.payload,/no longer matches/);
  await rename(path.join(config.root,'src/unit.gd'),path.join(config.root,'src/moved.gd'));
  assert.equal((await expandContext(args,config,{counter})).isError,true);
  assert.throws(()=>contextSchema.parse({...args,retrieval_id:'../escape'}));
  assert.throws(()=>contextSchema.parse({...args,max_lines:301}));
  assert.throws(()=>contextSchema.parse({...args,max_chars:24001}));
});

test('current ignore and telemetry exclusions are rechecked before adjacent source is returned', async () => {
  const {config,args}=await fixture();
  await writeFile(path.join(config.root,'.ignore'),'src/\n');
  const result=await expandContext(args,config,{counter});
  assert.equal(result.isError,true);assert.match(result.payload,/ignored or excluded/);
  assert.doesNotMatch(result.payload,/MISSED_BRANCH/);
  await writeFile(path.join(config.root,'.ignore'),'');
  const newDataDir=path.join(config.root,'src');
  await mkdir(path.join(newDataDir,args.retrieval_id));
  await writeFile(path.join(newDataDir,args.retrieval_id,'record.json'),await readFile(path.join(config.dataDir,args.retrieval_id,'record.json')));
  const telemetry=await expandContext(args,{...config,dataDir:newDataDir},{counter});
  assert.equal(telemetry.isError,true);assert.match(telemetry.payload,/ignored or excluded/);
});

test('replacing a source directory with a symlink cannot expose external context', async t => {
  const {config,args}=await fixture();
  const outside=await mkdtemp(path.join(os.tmpdir(),'jev-context-external-'));
  await writeFile(path.join(outside,'unit.gd'),content.replace('MISSED_BRANCH','EXTERNAL_SECRET'));
  await rename(path.join(config.root,'src'),path.join(config.root,'original-src'));
  try { await symlink(outside,path.join(config.root,'src'),'junction'); }
  catch(error) { if(error.code==='EPERM') {t.skip('OS does not allow test junction creation');return;} throw error; }
  const result=await expandContext(args,config,{counter});
  assert.equal(result.isError,true);assert.doesNotMatch(result.payload,/EXTERNAL_SECRET/);
});

test('large and binary files cannot bypass source limits after the search', async () => {
  const {config,args}=await fixture();
  const file=path.join(config.root,'src/unit.gd');
  await writeFile(file,content+'x'.repeat(1048577));
  const large=await expandContext(args,config,{counter});assert.equal(large.isError,true);assert.match(large.payload,/1 MiB/);
  await writeFile(file,content+'\0');
  assert.equal((await expandContext(args,config,{counter})).isError,true);
});

test('function detector handles nested Python, multiline headers and misleading strings', () => {
  const lines=['def outer(', '    arg,', '):', '    """doc', 'def fake():', '    still doc', '    """',
    '    def inner():', '        return "inside"', '    return arg', '', 'def other():', '    return 0'];
  const args=contextSchema.parse({retrieval_id:'00000000-0000-4000-8000-000000000000',candidate_id:'x',repository_root:os.tmpdir()});
  const outer=contextRange(lines,'a.py',10,args);
  assert.equal(outer.start_line,1);assert.equal(outer.end_line,10);
  const inner=contextRange(lines,'a.py',9,args);
  assert.equal(inner.start_line,8);assert.equal(inner.end_line,9);
  const doc=contextRange(lines,'a.py',5,args);
  assert.equal(doc.start_line,1);assert.equal(doc.end_line,10);
  const braces=contextRange(['def array():','    a = [','0,','1',']','    return a','def other():','    pass'],'a.py',6,args);
  assert.equal(braces.start_line,1);assert.equal(braces.end_line,6);
});

test('unsupported languages fall back explicitly and bounds keep the anchor', () => {
  const args=contextSchema.parse({retrieval_id:'00000000-0000-4000-8000-000000000000',candidate_id:'x',repository_root:os.tmpdir(),max_lines:3,max_chars:100});
  const lines=['func giant():',...Array.from({length:50},()=> '\treturn "some moderately long content"')];
  const clipped=contextRange(lines,'unit.gd',25,args);
  assert.equal(clipped.truncated,true);assert.ok(clipped.start_line<=25&&clipped.end_line>=25);
  assert.ok(clipped.text.length<=100);assert.ok(clipped.end_line-clipped.start_line+1<=3);
  assert.equal(contextRange(['a','b','c'],'code.js',2,args).selection,'surrounding_fallback');
  assert.throws(()=>contextRange(['x'.repeat(120)],'code.js',1,args),/exceeds max_chars/);
});

test('current content can change outside the saved passage; audit uses persisted context', async () => {
  const {config,args}=await fixture();
  const file=path.join(config.root,'src/unit.gd');
  await writeFile(file,content.replace('MISSED_BRANCH','NEW_BRANCH'));
  const result=await expandContext(args,config,{counter});
  assert.equal(result.isError,false);assert.match(result.payload,/NEW_BRANCH/);
  await writeFile(file,'completely changed later');
  assert.equal((await auditRecords(config.dataDir,[result.record])).all_successful_runs_verified,true);
});
