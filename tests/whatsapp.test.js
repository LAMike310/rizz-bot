'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseApprovedEvent,parseAddCommand,isOwnerSelfMessage,handleOwnerCommand,resolveTestContact,rememberApprovedAlias,chatMatchesApproved,localAuthOptions,contactMatchesNumber,savedContactName,whatsappMessageId} = require('../src/whatsapp');
const {DraftDelivery} = require('../src/drafts');
const {quietLogger} = require('./helpers');
const target='15551234567@c.us';
const owner='573001234567@c.us';
const aliases=new Set([target]); aliases.canonical=target;
function msg(extra={}) {return {id:{_serialized:'abc',fromMe:false},from:target,to:owner,type:'chat',body:'Hola',timestamp:1000,...extra};}

test('WhatsApp filter: only approved private incoming text is processed', () => {
  const parse = (m,kind='incoming')=>parseApprovedEvent(m,kind,aliases,30000,1000000,1000000);
  assert.equal(parse(msg()).chatId,target);
  assert.equal(parse(msg({from:{_serialized:target}})).chatId,target);
  assert.equal(parse(msg({from:undefined,to:owner,id:{_serialized:'abc',remote:target,fromMe:false}})).chatId,target);
  assert.equal(parse(msg({timestamp:undefined})).chatId,target);
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

test('Owner self-chat /add enables drafting and is ignored from anyone else', async () => {
  assert.equal(parseAddCommand('/add +573001234567'), '573001234567');
  assert.equal(parseAddCommand('/add 573001234567'), '573001234567');
  assert.equal(parseAddCommand('hola /add +573001234567'), null);
  const command = {id:{_serialized:'cmd',fromMe:true,remote:owner},from:owner,to:owner,fromMe:true,type:'chat',body:'/add +15551234567'};
  assert.equal(isOwnerSelfMessage(command, owner), true);
  assert.equal(isOwnerSelfMessage({...command, from:target, to:owner}, owner), false);
  assert.equal(isOwnerSelfMessage({...command, fromMe:false, id:{...command.id, fromMe:false}}, owner), false);
  const sent = [];
  const enabled = [];
  const aliases = new Set([target]);
  aliases.canonical = target;
  const handled = await handleOwnerCommand(command, {
    ownerId: owner,
    resolve: async () => aliases,
    enable: (row) => enabled.push(row),
    reply: async (id, text) => sent.push({id, text})
  });
  assert.equal(handled, true);
  assert.equal(enabled[0].chatId, target);
  assert.equal(enabled[0].phone, '15551234567');
  assert.equal(sent[0].text, 'Drafting enabled for +15551234567.');
  assert.equal(await handleOwnerCommand({...command, from:target, to:target}, {
    ownerId: owner, resolve: async () => aliases, enable() {}, reply: async () => sent.push('nope')
  }), false);
  assert.equal(sent.length, 1);
});

test('WhatsApp resolver: handles confirmed phone IDs and a mapped lid alias', async () => {
  const client={info:{wid:{_serialized:owner}},
    getNumberId:async()=>({_serialized:target}),
    getContactLidAndPhone:async()=>[{pn:target,lid:'123456789@lid'}]};
  const result=await resolveTestContact(client,'+1 (555) 123-4567',quietLogger());
  assert.equal(result.canonical,target);
  assert.equal(result.has('123456789@lid'),true);
});

test('WhatsApp resolver: accepts a user/server wid and a saved contact when lookup returns a lid', async () => {
  const bare={info:{wid:{user:'573001234567',server:'c.us'}},
    getNumberId:async()=>({user:'15551234567',server:'c.us'})};
  const fromParts=await resolveTestContact(bare,'15551234567',quietLogger());
  assert.equal(fromParts.canonical,target);
  const viaContact={info:{wid:{_serialized:owner}},
    getNumberId:async()=>({user:'999',server:'lid',_serialized:'999@lid'}),
    getContacts:async()=>[{id:{_serialized:target},number:'15551234567'}]};
  const fromBook=await resolveTestContact(viaContact,'15551234567',quietLogger());
  assert.equal(fromBook.canonical,target);
  assert.equal(fromBook.has('999@lid'),true);
  const named={info:{wid:{_serialized:owner}},
    getNumberId:async()=>({_serialized:target}),
    getContacts:async()=>[
      {id:{_serialized:target}, number:'15551234567', name:'Valentina', pushname:'Vale'},
      {id:{_serialized:'19998887777@c.us'}, number:'19998887777', name:'Someone Else'}
    ]};
  const withName=await resolveTestContact(named,'15551234567',quietLogger());
  assert.equal(withName.displayName,'Valentina');
  assert.equal(savedContactName({name:'+1 424 376 8718'}), '');
  assert.equal(savedContactName({pushname:'Vale'}), 'Vale');
});

test('WhatsApp filter: messages loaded from the approved chat are accepted even when the sender id is a new lid', () => {
  const mapped=new Set([target]); mapped.canonical=target;
  const parsed=parseApprovedEvent(msg({from:'555@lid',to:owner}), 'incoming', mapped, 30000, 1000000, 1000000, target);
  assert.equal(parsed.chatId, target);
});

test('WhatsApp filter: LID aliases persist as the canonical phone chat id', () => {
  const mapped=new Set([target,'999@lid']); mapped.canonical=target;
  const parsed=parseApprovedEvent(msg({from:'999@lid'}), 'incoming', mapped, 30000, 1000000, 1000000);
  assert.equal(parsed.chatId, target);
});

test('WhatsApp resolver: live LID map is added only when the phone matches the approved contact', async () => {
  const mapped=new Set([target]); mapped.canonical=target;
  const client={getContactLidAndPhone:async()=>[{lid:'999@lid',pn:target}]};
  assert.equal(await rememberApprovedAlias(client, mapped, '15551234567', '999@lid', quietLogger()), true);
  assert.equal(mapped.has('999@lid'), true);
  const other={getContactLidAndPhone:async()=>[{lid:'888@lid',pn:'19998887777@c.us'}]};
  assert.equal(await rememberApprovedAlias(other, mapped, '15551234567', '888@lid', quietLogger()), false);
  assert.equal(mapped.has('888@lid'), false);
  const alternateLid={getContactLidAndPhone:async()=>[{lid:'777@lid',pn:target}]};
  assert.equal(await rememberApprovedAlias(alternateLid, mapped, '15551234567', '555@lid', quietLogger()), true);
  assert.equal(mapped.has('555@lid'), true);
});

test('Approved chat matching uses the phone user id without opening the chat', () => {
  const mapped=new Set([target]); mapped.canonical=target;
  assert.equal(chatMatchesApproved({id:{_serialized:'999@lid',user:'15551234567'}}, mapped, '15551234567'), true);
  mapped.add('999@lid');
  assert.equal(chatMatchesApproved({id:{_serialized:'999@lid',user:'999'}}, mapped, '15551234567'), true);
  assert.equal(chatMatchesApproved({id:{_serialized:'19998887777@c.us',user:'19998887777'}}, mapped, '15551234567'), false);
  assert.equal(chatMatchesApproved({id:{_serialized:'group@g.us',user:'group'}}, mapped, '15551234567'), false);
});

test('Contact phone match uses phoneNumber and ignores a hidden userid', () => {
  assert.equal(contactMatchesNumber({userid:'999999999999999', phoneNumber:{user:'15551234567', server:'c.us'}}, '15551234567'), true);
  assert.equal(contactMatchesNumber({userid:'15551234567', phoneNumber:{user:'19998887777', server:'c.us'}}, '15551234567'), false);
  const parsed = parseApprovedEvent(msg({id:{id:'abc', remote:target, fromMe:false}}), 'incoming', aliases, 30000, 1000000, 1000000);
  assert.equal(parsed.whatsappId, 'them_15551234567@c.us_abc');
  assert.equal(whatsappMessageId({id:{id:'abc', remote:target, fromMe:false}}), 'them_15551234567@c.us_abc');
});

test('LocalAuth options reuse the configured parent auth path and client id', () => {
  const options = localAuthOptions({clientId:'dating-agent', authPath:'/tmp/existing/.wwebjs_auth'});
  assert.equal(options.clientId, 'dating-agent');
  assert.equal(options.dataPath, '/tmp/existing/.wwebjs_auth');
  assert.equal(options.dataPath.endsWith('session-dating-agent'), false);
});

test('Draft Delivery: sends only to authenticated self-chat and refuses unsafe destinations', async () => {
  const sent=[];
  const draft={id:1,options:[
    {style:'natural',reply_es:'Hola',translation_en:'Hi'},
    {style:'playful',reply_es:'Hola jaja',translation_en:'Hi haha'},
    {style:'direct',reply_es:'Hola, cómo vas?',translation_en:'Hi, how are you?'}
  ]};
  const client={info:{wid:{_serialized:owner}},sendMessage:async(id,text)=>{sent.push({id,text});return {id:{_serialized:'note-9'}};}};
  const d=new DraftDelivery({client,testChatId:target,logger:quietLogger()});
  assert.deepEqual(await d.deliver(draft,{beforeSend:()=>true}),{status:'notified',whatsappId:'note-9'});
  assert.equal(sent.length,1);
  assert.equal(sent[0].id,owner);
  assert.match(sent[0].text,/\*US TEST CONTACT\* · #1/);
  assert.match(sent[0].text,/\*1 · NATURAL\*/);
  assert.deepEqual(await d.deliver(draft,{beforeSend:()=>false}),{status:'stale',whatsappId:null});
  assert.equal(sent.length,1);
  const unsafe=new DraftDelivery({client:{...client,info:{wid:{_serialized:target}}},testChatId:target,logger:quietLogger()});
  assert.deepEqual(await unsafe.deliver(draft),{status:'failed',whatsappId:null});
  const partial=[];
  const partialClient={
    info:{wid:{_serialized:owner}},
    sendMessage:async()=>({id:{fromMe:true,remote:owner,id:'ABC123'}}),
    getChatById:async()=>({fetchMessages:async()=>[]})
  };
  const recovered=new DraftDelivery({client:partialClient,testChatId:target,logger:quietLogger()});
  assert.equal((await recovered.deliver(draft,{beforeSend:()=>true})).whatsappId,`true_${owner}_ABC123`);
  assert.equal(partial.length,0);
  assert.equal(sent.length,1);
});
