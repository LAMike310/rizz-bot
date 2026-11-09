'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {OpenRouter,parseDraft,validateDraft} = require('../src/openrouter');
const {suggested, quietLogger} = require('./helpers');

test('Parser accepts valid JSON and fenced JSON, rejects malformed or incomplete data', () => {
  const valid=JSON.stringify({should_reply:true,reply_es:'Hola',translation_en:'Hi',reason:'test'});
  assert.equal(parseDraft(valid).reply_es,'Hola');
  assert.equal(parseDraft('```json\n'+valid+'\n```').reply_es,'Hola');
  assert.throws(()=>parseDraft('Hola'),/valid JSON/);
  assert.throws(()=>validateDraft({should_reply:true,reply_es:'Hi',translation_en:'',reason:''}),/empty/);
  assert.deepEqual(parseDraft(JSON.stringify({should_reply:false,reply_es:'',translation_en:'',reason:'no answer'})).should_reply,false);
});

test('OpenRouter: sends model, history, prompt and validates a structured result', async () => {
  let request;
  const ai = new OpenRouter({apiKey:'TEST_SECRET',model:'free/sample',outputMode:'json_schema',logger:quietLogger(),
    fetchImpl: async (url,opts) => {
      request={url,opts,body:JSON.parse(opts.body)};
      return {ok:true,json:async()=>({model:'provider/actual',choices:[{message:{content:JSON.stringify({should_reply:suggested.should_reply,reply_es:suggested.reply_es,translation_en:suggested.translation_en,reason:suggested.reason})}}],usage:{total_tokens:50}})};
    }});
  const result=await ai.generate({history:[{direction:'incoming',body:'Hola'},{direction:'outgoing',body:'Hola, qué tal?'}],prompt:'Be concise',profile:{name:'Mike'}});
  assert.equal(result.model,'provider/actual');
  assert.equal(result.reply_es,suggested.reply_es);
  assert.equal(request.body.model,'free/sample');
  assert.equal(request.body.response_format.type,'json_schema');
  assert.equal(request.body.messages[1].role,'user');
  assert.equal(request.body.messages[2].role,'assistant');
  assert.equal(request.opts.headers.Authorization,'Bearer TEST_SECRET');
  assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
});

test('OpenRouter: 401 fails without retry, 503 retries exactly once', async () => {
  let calls=0;
  const ai=new OpenRouter({apiKey:'x',model:'free/test',maxRetries:1,sleep:async()=>{},logger:quietLogger(),
    fetchImpl:async()=>{calls++; if(calls===1)return {ok:false,status:503}; return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({should_reply:suggested.should_reply,reply_es:suggested.reply_es,translation_en:suggested.translation_en,reason:suggested.reason})}}]})};}});
  assert.equal((await ai.generate({history:[],prompt:'p',profile:{}})).should_reply,true);
  assert.equal(calls,2);
  let authCalls=0;
  const unauthorized=new OpenRouter({apiKey:'x',model:'x',maxRetries:2,logger:quietLogger(),fetchImpl:async()=>{authCalls++;return {ok:false,status:401};}});
  await assert.rejects(unauthorized.generate({history:[],prompt:'p',profile:{}}),/HTTP 401/);
  assert.equal(authCalls,1);
});
