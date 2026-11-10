const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('mods/project-changes/main.js', 'utf8');
const contents = {
  'large.js': Array.from({length: 2000}, (_, i) => `line ${i}`).join('\n'),
  'empty.js': '', 'binary.dat': 'a\0b', 'unavailable.dat': null,
  'spaces and 中文.js': 'one\ntwo\n',
};
const chain = () => new Proxy({}, {get: () => () => chain()});
const focus = {space:'s', tab:'t', pane:'p', cwd:'/repo'};
const jobs = [];
const host = {
  View: class {}, focused: () => focus, spaces: () => [{active:true, folder:'/repo'}],
  panes: () => [{pane:'p', cwd:'/repo'}],
  exec: async (_command, args) => ({code:0, stderr:'', stdout: args.includes('--show-toplevel') ? '/repo\n' : args.includes('--porcelain=v1') ? Object.keys(contents).map(path => `?? ${path}\0`).join('') : args.includes('--verify') ? 'HEAD' : ''}),
  readTextFile: async path => contents[path.replace('/repo/', '')],
  localStorage: {setItem(){}}, agents: () => [],
  div:chain, v_flex:chain, h_flex:chain,
};
vm.createContext(host);
vm.runInContext(source.replace(/^import .*;\n/gm, '').replace('export default class Changes', 'globalThis.Changes = class Changes'), host);
const panel = new host.Changes();
Object.assign(panel, {files:[],rows:[],reviews:{},editors:{},input:{set_value(){}},watch(){}});
const cx = {notify(){}, spawn(fn){jobs.push(fn(cx));}};
(async () => {
  panel.refresh(cx); await Promise.all(jobs);
  const file = path => panel.files.find(f => f.path === path);
  assert.equal(file('large.js').add, 2000);
  assert.equal(file('spaces and 中文.js').add, 2); // Counts before the file is opened.
  assert.equal(file('empty.js').add, 0);
  assert.equal(file('binary.dat').binary, true);
  assert.equal(file('unavailable.dat').countUnavailable, true);
  assert.equal(panel.rows.length, 1500);
  let rendered = 0;
  panel.diffRow = () => {rendered++; return chain();};
  for (const page of [0, 1, 18]) {
    panel.diffPage = page; rendered = 0; panel.reviewDiff({});
    assert.ok(rendered > 0 && rendered <= 80);
  }
  panel.open = 'empty.js'; await panel.load('empty.js', panel.context);
  assert.equal(panel.rows.length, 1);
  assert.match(panel.rows[0].text, /Empty file/);
  assert.equal(panel.rows[0].number, undefined);
  console.log('PASS: upfront full-file counts, empty/binary/unreadable files, Unicode paths, and bounded large-file pages.');
})().catch(error => {console.error(error);process.exitCode=1;});
