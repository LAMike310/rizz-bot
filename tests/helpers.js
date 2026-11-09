'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Store} = require('../src/db');
class Clock {
  constructor() {this.t = 0; this.next = 1; this.events = new Map();}
  setTimeout = (fn, delay) => { const id = this.next++; this.events.set(id, {at: this.t + delay, fn}); return id; };
  clearTimeout = (id) => this.events.delete(id);
  tick(ms) {
    const target = this.t + ms;
    while (true) {
      const next = [...this.events.entries()].sort((a,b) => a[1].at-b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.events.delete(next[0]); this.t = next[1].at; next[1].fn();
    }
    this.t = target;
  }
}
function dbFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-'));
  const filename = path.join(dir, 'test.db');
  const db = new Store(filename, {driver: 'builtin'});
  db.enableTestContact('15551234567@c.us', '15551234567');
  function close() {db.close(); fs.rmSync(dir, {recursive:true, force:true});}
  return {db,dir,filename,close,chat:'15551234567@c.us'};
}
function agentConfig() {
  return {
    debounceMs: 45000, maxHistory:30,
    promptPath: path.join(__dirname, '../prompts/dating.md'),
    profilePath: path.join(__dirname, '../prompts/me.json')
  };
}
function quietLogger() {return {debug(){},info(){},warn(){},error(){}};}
function incoming(chatId, id, body, timestamp=1234567890) {
  return {chatId, whatsappId:id,body,timestamp};
}
function deferred() {let resolve, reject; const promise = new Promise((r,j)=>{resolve=r; reject=j;}); return {promise,resolve,reject};}
const suggested = {should_reply:true, model:'mock-model', usage:{prompt_tokens:10,completion_tokens:12}, options:[
  {style:'natural', reply_es:'Todo bien. Y tú?', translation_en:'All good. And you?'},
  {style:'playful', reply_es:'Jaja todo bien. Qué haces?', translation_en:'Haha all good. What are you up to?'},
  {style:'direct', reply_es:'Todo bien. Cuéntame de tu día.', translation_en:'All good. Tell me about your day.'}
]};
module.exports = {Clock,dbFixture,agentConfig,quietLogger,incoming,deferred,suggested};
