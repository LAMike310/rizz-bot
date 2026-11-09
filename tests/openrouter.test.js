'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OpenRouter,parseDraft,validateDraft} = require('../src/openrouter');
const {suggested, quietLogger} = require('./helpers');

test('Parser accepts three options and rejects malformed or incomplete data', () => {
  const valid=JSON.stringify({should_reply:true,options:suggested.options});
  assert.equal(parseDraft(valid).options[0].reply_es,suggested.options[0].reply_es);
  assert.equal(parseDraft('```json\n'+valid+'\n```').options.length,3);
  assert.throws(()=>parseDraft('Hola'),/valid JSON/);
  assert.throws(()=>validateDraft({should_reply:true,options:[{style:'natural',reply_es:'Hi',translation_en:''}]}),/exactly three/);
  assert.equal(parseDraft(JSON.stringify({should_reply:false,options:[]})).should_reply,false);
  const labeled = suggested.options.map((option, index) => ({...option, label: ['Confirm plans', 'Pizza joke', 'Offers Uber'][index]}));
  assert.equal(parseDraft(JSON.stringify({should_reply:true, options:labeled})).options[1].label, 'Pizza joke');
  const messy = suggested.options.map((option, index) => ({...option, label: index === 0 ? 'NATURAL' : 'this label is far too long'}));
  assert.equal(parseDraft(JSON.stringify({should_reply:true, options:messy})).options[0].label, undefined);
  assert.equal(parseDraft(JSON.stringify({should_reply:true, options:messy})).options[0].reply_es, suggested.options[0].reply_es);
});

test('OpenRouter: sends model, history, prompt and validates a structured result', async () => {
  let request;
  const ai = new OpenRouter({apiKey:'TEST_SECRET',model:'free/sample',outputMode:'json_schema',logger:quietLogger(),
    fetchImpl: async (url,opts) => {
      request={url,opts,body:JSON.parse(opts.body)};
      return {ok:true,json:async()=>({model:'provider/actual',choices:[{message:{content:JSON.stringify({should_reply:true,options:suggested.options})}}],usage:{total_tokens:50}})};
    }});
  const result=await ai.generate({history:[{direction:'incoming',body:'Hola'},{direction:'outgoing',body:'Hola, qué tal?'}],prompt:'Be concise',profile:{name:'Mike'}});
  assert.equal(result.model,'provider/actual');
  assert.equal(result.options[1].style,'playful');
  assert.equal(request.body.model,'free/sample');
  assert.equal(request.body.response_format.type,'json_schema');
  assert.equal(request.body.messages[1].role,'user');
  assert.equal(request.body.messages[2].role,'assistant');
  assert.equal(request.opts.headers.Authorization,'Bearer TEST_SECRET');
  assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
});

test('OpenRouter: revision sends the owner feedback and the current options', async () => {
  let request;
  const ai = new OpenRouter({apiKey:'TEST_SECRET',model:'free/sample',logger:quietLogger(),
    fetchImpl: async (_url,opts) => {
      request = JSON.parse(opts.body);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({should_reply:true,options:suggested.options})}}]})};
    }});
  const result = await ai.revise({
    history:[{direction:'incoming',body:'Hola'}],
    prompt:'Be concise',
    profile:{name:'Mike'},
    options:suggested.options,
    feedback:'make the number two message more playful',
    draftId:16
  });
  assert.equal(result.options.length, 3);
  const last = request.messages.at(-1).content;
  assert.match(last, /make the number two message more playful/);
  assert.match(last, /draft #16/);
  assert.match(last, /playful/);
  assert.equal(request.messages[1].content, 'Hola');
});

test('OpenRouter: invalid JSON is retried once, then surfaced', async () => {
  let calls = 0;
  const recovering = new OpenRouter({apiKey:'x', model:'free/test', maxRetries:0, sleep:async()=>{}, logger:quietLogger(),
    fetchImpl: async () => {
      calls++;
      const content = calls === 1 ? 'not json' : JSON.stringify({should_reply:true, options:suggested.options});
      return {ok:true, json:async()=>({choices:[{message:{content}}]})};
    }});
  assert.equal((await recovering.generate({history:[], prompt:'p', profile:{}})).should_reply, true);
  assert.equal(calls, 2);
  let failed = 0;
  const stuck = new OpenRouter({apiKey:'x', model:'free/test', maxRetries:2, sleep:async()=>{}, logger:quietLogger(),
    fetchImpl: async () => {
      failed++;
      return {ok:true, json:async()=>({choices:[{message:{content:'nope'}}]})};
    }});
  await assert.rejects(stuck.generate({history:[], prompt:'p', profile:{}}), err => err.invalidOutput && /valid JSON/.test(err.message));
  assert.equal(failed, 2);
});

test('OpenRouter: 401 fails without retry, 503 retries exactly once', async () => {
  let calls=0;
  const ai=new OpenRouter({apiKey:'x',model:'free/test',maxRetries:1,sleep:async()=>{},logger:quietLogger(),
    fetchImpl:async()=>{calls++; if(calls===1)return {ok:false,status:503}; return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({should_reply:true,options:suggested.options})}}]})};}});
  assert.equal((await ai.generate({history:[],prompt:'p',profile:{}})).should_reply,true);
  assert.equal(calls,2);
  let authCalls=0;
  const unauthorized=new OpenRouter({apiKey:'x',model:'x',maxRetries:2,logger:quietLogger(),fetchImpl:async()=>{authCalls++;return {ok:false,status:401};}});
  await assert.rejects(unauthorized.generate({history:[],prompt:'p',profile:{}}),/HTTP 401/);
  assert.equal(authCalls,1);
});
