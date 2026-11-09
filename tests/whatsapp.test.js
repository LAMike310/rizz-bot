'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseApprovedEvent,resolveTestContact} = require('../src/whatsapp');
const {DraftDelivery} = require('../src/drafts');
const {quietLogger} = require('./helpers');
const target='15551234567@c.us';
const owner='573001234567@c.us';
const aliases=new Set([target]); aliases.canonical=target;
function msg(extra={}) {return {id:{_serialized:'abc',fromMe:false},from:target,to:owner,type:'chat',body:'Hola',timestamp:1000,...extra};}

test('WhatsApp filter: only approved private incoming text is processed', () => {
  const parse = (m,kind='incoming')=>parseApprovedEvent(m,kind,aliases,30000,1000000,1000000);
  assert.equal(parse(msg()).chatId,target);
  assert.equal(parse(msg({from:'999@c.us'})),null);
  assert.equal(parse(msg({from:'456@g.us'})),null);
  assert.equal(parse(msg({type:'image'})),null);
  assert.equal(parse(msg({body:''})),null);
  assert.equal(parse(msg({from:owner,to:owner})),null);
  assert.equal(parse(msg({timestamp:900})),null); // stale synced history
  assert.equal(parse(msg({id:{_serialized:'x',fromMe:true},fromMe:true})),null);
});

test('WhatsApp filter: manual outgoing is recognized; self-chat and groups are ignored', () => {
  const out={...msg(),id:{_serialized:'mine',fromMe:true},from:owner,to:target,fromMe:true};
  assert.equal(parseApprovedEvent(out,'outgoing',aliases,30000,1000000,1000000).chatId,target);
  assert.equal(parseApprovedEvent({...out,to:owner},'outgoing',aliases,30000,1000000,1000000),null);
  assert.equal(parseApprovedEvent({...out,to:'xyz@g.us'},'outgoing',aliases,30000,1000000,1000000),null);
});

test('WhatsApp resolver: handles confirmed phone IDs and a mapped lid alias', async () => {
  const client={info:{wid:{_serialized:owner}},
    getNumberId:async()=>({_serialized:target}),
    getContactLidAndPhone:async()=>[{pn:target,lid:'123456789@lid'}]};
  const result=await resolveTestContact(client,'+1 (555) 123-4567',quietLogger());
  assert.equal(result.canonical,target);
  assert.equal(result.has('123456789@lid'),true);
});

test('Draft Delivery: sends only to authenticated self-chat and refuses unsafe destinations', async () => {
  const sent=[];
  const client={info:{wid:{_serialized:owner}},sendMessage:async(id,text)=>sent.push({id,text})};
  const d=new DraftDelivery({client,testChatId:target,logger:quietLogger()});
  const draft={id:1,reply_es:'Hola',translation_en:'Hi',reason:'test'};
  assert.equal(await d.deliver(draft,{beforeSend:()=>true}),'notified');
  assert.equal(sent.length,1);
  assert.equal(sent[0].id,owner);
  assert.match(sent[0].text,/DRAFT #1/);
  assert.equal(await d.deliver(draft,{beforeSend:()=>false}),'stale');
  assert.equal(sent.length,1);
  const unsafe=new DraftDelivery({client:{...client,info:{wid:{_serialized:target}}},testChatId:target,logger:quietLogger()});
  assert.equal(await unsafe.deliver(draft),'failed');
  assert.equal(sent.length,1);
});
