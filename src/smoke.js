'use strict';
// Fully offline integration smoke test: real SQLite + agent + OpenRouter
// transport stub + self-chat send stub; no phone, credentials, or internet.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {Store} = require('./db');
const {DatingAgent} = require('./agent');
const {DraftDelivery} = require('./drafts');
const {OpenRouter} = require('./openrouter');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-smoke-'));
  const db = new Store(path.join(dir,'test.db'));
  const chatId='15551234567@c.us';
  db.enableTestContact(chatId,'15551234567');
  const sent=[];
  const owner='573001234567@c.us';
  const client={info:{wid:{_serialized:owner}},sendMessage:async(to,text)=>{sent.push({to,text});return {id:'mock-send'};}};
  let requestCount=0;
  const model=new OpenRouter({apiKey:'mock-key',model:'offline/mock',maxRetries:0,
    fetchImpl:async(url,opts)=>{
      requestCount++;
      assert.match(opts.body,/Qué haces/);
      return {ok:true,json:async()=>({model:'offline/mock',choices:[{message:{content:JSON.stringify({
        should_reply:true,reply_es:'Todo bien, y tú?',translation_en:'All good, and you?',reason:'Responding to greeting.'
      })}}],usage:{prompt_tokens:100,completion_tokens:40}})};
    }});
  const agent=new DatingAgent({db,ai:model,
    drafts:new DraftDelivery({client,testChatId:chatId,logger:console}),
    config:{debounceMs:150,maxHistory:30,
      promptPath:path.resolve(__dirname,'../prompts/dating.md'),
      profilePath:path.resolve(__dirname,'../prompts/me.json')},logger:console});
  try {
    agent.onIncoming({chatId,whatsappId:'one',body:'Hola',timestamp:1});
    await new Promise(resolve=>setTimeout(resolve,65));
    agent.onIncoming({chatId,whatsappId:'two',body:'Qué haces?',timestamp:2});
    await new Promise(resolve=>setTimeout(resolve,290));
    await agent.drain();
    assert.equal(requestCount,1);
    assert.equal(sent.length,1);
    assert.equal(sent[0].to,owner);
    assert.equal(db.countMessages(chatId),2);
    assert.equal(db.draftsFor(chatId)[0].status,'notified');
    console.log('\nPASS: 2-message burst -> SQLite -> mocked OpenRouter -> self-chat only');
  } finally {
    agent.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error('FAIL:',error);process.exitCode=1;});
