const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
let f={tab:'one',space:'project',terminal:'a',pane:'p',cwd:'/repo'}, agentList=[{address:'a',tab:'one',space:'project',title:'Codex'}], messages=[],jobs=[],fail=false,store={};
const chain=()=>new Proxy({}, {get(_t,k){if(k==='when')return (yes,fn)=>{if(yes)fn(chain());return chain()};return ()=>chain()}});
const input=opts=>{let value=opts.value??'',handlers={};return {value:()=>value,set_value(text){value=text},on:(k,fn)=>handlers[k]=fn,focus(){},release(){},type(text){value=text;handlers.change({},cx)}}};
const box={View:class{},focused:()=>f,spaces:()=>[{id:'project',active:true,folder:'/repo'}],panes:()=>[{pane:'p',cwd:'/repo'}],agents:()=>agentList,hc:async args=>{messages.push(args);return {code:fail?1:0,stderr:'blocked'}},localStorage:{getItem:k=>store[k],setItem:(k,v)=>store[k]=v},TextareaState:{new:input},Textarea:{new:chain},div:chain,h_flex:chain,v_flex:chain};
vm.createContext(box);vm.runInContext(fs.readFileSync('mods/project-changes/main.js','utf8').replace(/^import .*;\n/gm,'').replace('export default class Changes','globalThis.Changes = class Changes'),box);
const p=new box.Changes();Object.assign(p,{root:'/repo',on:null,context:vm.runInContext('key()',box),reviews:{},editors:{},handle:{focus(){}},open:'one.js',sending:false,rows:[],diffWidth:300});
const cx={focus_handle(){return {focus(){}}},stop_propagation(){},bind_keys(){},notify(){},spawn(fn){jobs.push(fn(cx))}};
(async()=>{
 p.beginComment({kind:'+',number:3,text:'new line'},cx);let review=p.review(),c=review.comments[0];p.editors[c.id].type('First comment\nMore detail');
 p.addComment(c,cx);assert.equal(c.editing,false);
 p.open='two.js';p.beginComment({kind:'-',number:9,text:'old line'},cx);c=review.comments[1];p.editors[c.id].type('Second comment');
 assert.equal(review.comments.length,2);assert.equal(JSON.parse(store['reviews.v1'])[review.id].comments.length,2);
 assert.equal(p.sameAnchor(review.comments[1],{kind:'-',number:9,text:'old line'}),true);
 assert.equal(p.sameAnchor(review.comments[1],{kind:'+',number:9,text:'old line'}),false);
 p.addComment(c,cx);p.renderDiffChunk(0,{});p.reviewFooter({});
 f={...f,tab:'other'};p.sendReview(cx);assert.equal(messages.length,0);f={...f,tab:'one'};
 agentList.push({address:'b',tab:'one',space:'project'});p.sendReview(cx);assert.equal(messages.length,0);review.address='a';
 fail=true;p.sendReview(cx);await Promise.all(jobs);jobs=[];assert.equal(review.comments.length,2);assert.match(review.notice,/drafts kept/);
 fail=false;p.sendReview(cx);await Promise.all(jobs);jobs=[];assert.equal(messages.length,2);assert.match(messages[1][2],/one.js:3 \(new version\)/);assert.match(messages[1][2],/two.js:9 \(old version\)/);assert.match(messages[1][2],/More detail/);assert.equal(review.comments.length,0);
 assert.equal(JSON.parse(store['reviews.v1'])[review.id].comments.length,0);

 // Repeated clicks focus one editor; unsaved empty placeholders are reused/discarded.
 p.open='range.js';
 p.rows=vm.runInContext(`diffRows(['@@ -10,4 +10,4 @@',' context','-removed','+added',' context two',' context three','@@ -30 +30 @@','+later'])`,box);
 const rows=p.rows;
 p.beginComment(rows[1],cx);let draft=review.comments[0];
 p.editors[draft.id].type('One thread');
 p.beginComment(rows[1],cx);assert.equal(review.comments.length,1);assert.equal(review.comments[0],draft);
 // Range drag downward captures new/context lines, excludes removed lines, and opens at release.
 p.startSelection(rows[1],cx);p.extendSelection(rows[5],cx);assert.equal(review.comments.length,1);
 p.finishSelection(cx);let range=review.comments.at(-1);
 assert.equal(range.number,10);assert.equal(range.endNumber,13);assert.equal(range.side,'new');
 assert.match(range.code,/added/);assert.ok(!range.code.includes('removed'));
 p.editors[range.id].type('Range review');p.addComment(range,cx);
 const count=review.comments.length;
 // Dragging in reverse reuses the same range/thread.
 p.startSelection(rows[5],cx);p.extendSelection(rows[1],cx);p.finishSelection(cx);
 assert.equal(review.comments.length,count);assert.equal(review.comments.at(-1),range);
 assert.equal(p.sameAnchor(range,rows[5]),true);assert.equal(p.sameAnchor(range,rows[1]),false);
 // Deleted-side ranges can include context but never added code.
 p.startSelection(rows[2],cx);p.extendSelection(rows[4],cx);p.finishSelection(cx);
 const deleted=review.comments.at(-1);assert.equal(deleted.side,'old');assert.equal(deleted.number,11);assert.equal(deleted.endNumber,12);
 assert.match(deleted.code,/removed/);assert.ok(!deleted.code.includes('added'));
 p.editors[deleted.id].type('Deleted range');p.addComment(deleted,cx);
 // A range cannot silently cross a hunk boundary or leak across tab switches.
 p.startSelection(rows[1],cx);p.extendSelection(rows[7],cx);assert.equal(p.selection.end,rows[1].index);
 f={...f,tab:'other'};const before=review.comments.length;p.finishSelection(cx);assert.equal(review.comments.length,before);f={...f,tab:'one'};
 // File comments also reuse their thread.
 p.beginComment(null,cx);const file=review.comments.at(-1);p.beginComment(null,cx);assert.equal(review.comments.at(-1),file);
 p.editors[file.id].type('File review');
 // Only explicitly added comments enter the batch; draft file comments stay local.
 p.addComment(range,cx);p.sendReview(cx);await Promise.all(jobs);jobs=[];
 const last=messages.at(-1)[2];assert.match(last,/range.js:10-13 \(new version\)/);assert.ok(!last.includes('File review'));
 assert.ok(review.comments.includes(file));

 p.cancelComment(file,review,cx);assert.ok(!review.comments.includes(file));
 p.beginComment(rows[1],cx);const saved=review.comments.at(-1);p.editors[saved.id].type('Original');p.addComment(saved,cx);
 p.beginComment(rows[1],cx);p.editors[saved.id].type('Changed');p.cancelComment(saved,review,cx);
 assert.equal(saved.body,'Original');assert.equal(saved.editing,false);
 // Shift-click extends from the previous line-number anchor.
 p.startSelection(rows[1],cx);p.finishSelection(cx);
 p.startSelection(rows[5],cx,{modifiers:{shift:true}});p.finishSelection(cx);
 assert.equal(review.comments.at(-1).number,10);assert.equal(review.comments.at(-1).endNumber,13);

 // Exercise the native textarea's submit event, including its preceding newline insertion.
 const keyboard=review.comments.at(-1);keyboard.body='Keyboard comment';keyboard.editing=true;
 const input=p.editors[keyboard.id];input.type('Keyboard comment');
 // Plain Enter adds a newline first; the submit listener must undo only that insertion.
 input.type('Keyboard\n comment');p.submitComment({shift:false,secondary:false},keyboard,review,input,cx);
 assert.equal(keyboard.body,'Keyboard comment');assert.equal(keyboard.editing,false);
 keyboard.editing=true;input.type('Keyboard\n comment');
 p.submitComment({shift:true,secondary:false},keyboard,review,input,cx);
 assert.equal(keyboard.body,'Keyboard\n comment');assert.equal(keyboard.editing,true);
 // Native Enter may deliver submit before the change callback; handle that ordering too.
 keyboard.body='Hello world';input.set_value('Hello\n world');
 p.submitComment({shift:false,secondary:false},keyboard,review,input,cx);
 assert.equal(keyboard.body,'Hello world');assert.equal(keyboard.editing,false);
 keyboard.editing=true;input.type('a\nb');input.type('a\n\nb');
 p.submitComment({shift:false,secondary:false},keyboard,review,input,cx);
 assert.equal(keyboard.body,'a\nb');assert.equal(keyboard.editing,false);

 // Strong range feedback persists after mouse release while the draft is open.
 p.startSelection(rows[1],cx);p.extendSelection(rows[5],cx);
 assert.equal(p.isSelectedLine(rows[1]),true);assert.equal(p.isSelectedLine(rows[5]),true);
 assert.equal(p.isSelectedLine(rows[2]),false);assert.equal(p.isSelectedLine(rows[7]),false);
 p.finishSelection(cx);
 assert.equal(p.isSelectedLine(rows[1]),true);assert.equal(p.isSelectedLine(rows[5]),true);
 p.addComment(p.activeComment.c,cx);assert.equal(p.isSelectedLine(rows[1]),false);
 p.startSelection(rows[1],cx);p.extendSelection(rows[5],cx);p.finishSelection(cx);
 p.removeComment(p.activeComment.c,review,cx);assert.equal(p.isSelectedLine(rows[1]),false);assert.equal(p.activeComment,null);
 p.startSelection(rows[1],cx);p.extendSelection(rows[5],cx);p.finishSelection(cx);
 p.cancelComment(p.activeComment.c,review,cx);assert.equal(p.isSelectedLine(rows[1]),false);

 let stopped=0;const wheelCx={stop_propagation(){stopped++;}};
 p.guardDiffScroll({delta:{x:0,y:-40}},wheelCx);assert.equal(stopped,1);
 p.guardDiffScroll({delta:{x:2,y:-40}},wheelCx);assert.equal(stopped,2);
 p.guardDiffScroll({delta:{x:-40,y:0}},wheelCx);assert.equal(stopped,2);
 p.guardDiffScroll({delta:{x:40,y:2}},wheelCx);assert.equal(stopped,2);

 const badgeReview=p.review();badgeReview.comments=[
   {path:'a.js',body:'First'}, {path:'a.js',body:'Second',editing:true},
   {path:'b.js',body:'Third'}, {path:'empty.js',body:'   '}
 ];
 assert.equal(p.commentCounts()['a.js'],2);assert.equal(p.commentCounts()['b.js'],1);
 assert.equal(p.commentCounts()['empty.js'],undefined);
 badgeReview.comments.splice(0,1);assert.equal(p.commentCounts()['a.js'],1);
 f={...f,tab:'other'};assert.equal(Object.keys(p.commentCounts()).length,0);

 // Clear all is scoped to the current review, includes drafts, and persists.
 const elsewhere={id:'elsewhere',comments:[{id:'keep',path:'keep.js',body:'Keep me'}]};p.reviews.elsewhere=elsewhere;
 f={...f,tab:'one'};
 p.activeComment={review:badgeReview,c:badgeReview.comments[0]};p.selection={start:1,end:2};
 p.sending=true;p.clearComments(cx);assert.equal(badgeReview.comments.length,3);p.sending=false;
 p.clearComments(cx);assert.equal(badgeReview.comments.length,0);assert.equal(p.activeComment,null);assert.equal(p.selection,null);
 assert.equal(elsewhere.comments.length,1);assert.equal(Object.keys(p.commentCounts()).length,0);
 assert.equal(JSON.parse(store['reviews.v1'])[badgeReview.id].comments.length,0);
 console.log('PASS: repeated anchors, forward/reverse drag ranges, old/new context, hunk/tab boundaries, persistent drafts, explicit Add, and same-tab batch send, native Enter submit, Shift+Enter, and newline cleanup.');
})().catch(e=>{console.error(e);process.exit(1)});
