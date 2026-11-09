'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {DatingAgent} = require('../src/agent');
const {Clock,dbFixture,agentConfig,quietLogger,incoming,deferred,suggested} = require('./helpers');
function setup({aiGenerate=async()=>suggested,deliver=async()=>({status:'notified', whatsappId:'note-1'})}={}) {
  const f=dbFixture(); const clock=new Clock();
  const calls=[];const notified=[];
  const agent=new DatingAgent({db:f.db,config:agentConfig(),logger:quietLogger(),
    ai:{generate:async(args)=>{calls.push(args);return aiGenerate(args);}},
    drafts:{deliver:async(draft,opts)=>{notified.push({draft,opts});return deliver(draft,opts);}},
    setTimer:clock.setTimeout, clearTimer:clock.clearTimeout,now:()=>clock.t
  });
  return {...f,clock,agent,calls,notified};
}
test('Agent: two invalid JSON attempts tell the owner to handle this round', async () => {
  const notices = [];
  const error = new Error('AI output is not valid JSON');
  error.invalidOutput = true;
  const x = setup({aiGenerate: async () => { throw error; }});
  x.agent.drafts.notifyOwner = async (text) => { notices.push(text); };
  try {
    x.agent.onIncoming(incoming(x.chat, 'a', 'Hola'));
    x.clock.tick(45000);
    await x.agent.drain();
    assert.deepEqual(notices, ["Sorry, you're on your own this round."]);
    assert.equal(x.db.draftsFor(x.chat).length, 0);
  } finally { x.agent.stop(); x.close(); }
});
test('Agent: one incoming message produces one persisted and notified draft at 45 seconds',async()=>{
  const x=setup(); try {
    assert.equal(x.agent.onIncoming(incoming(x.chat,'a','Hola')),true);
    x.clock.tick(44999);assert.equal(x.calls.length,0);
    x.clock.tick(1);await x.agent.drain();
    assert.equal(x.calls.length,1);assert.equal(x.notified.length,1);
    assert.equal(x.db.draftsFor(x.chat)[0].status,'active');
  } finally {x.agent.stop();x.close();}
});
test('Agent: a three-message burst yields one prompt with all three',async()=>{
  const x=setup();try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));
    x.clock.tick(7000);
    x.agent.onIncoming(incoming(x.chat,'b','Qué más'));
    x.clock.tick(12000);
    x.agent.onIncoming(incoming(x.chat,'c','Viernes?'));
    x.clock.tick(44999);
    assert.equal(x.calls.length,0);
    x.clock.tick(1); await x.agent.drain();
    assert.equal(x.calls.length,1);
    assert.deepEqual(x.calls[0].history.map(m=>m.body),['Hola','Qué más','Viernes?']);
    assert.equal(x.db.countMessages(x.chat),3);
  }finally{x.agent.stop();x.close();}
});
test('Agent: duplicate messages and unapproved contacts do nothing',async()=>{
  const x=setup();try {
    assert.equal(x.agent.onIncoming(incoming(x.chat,'same','Hola')),true);
    assert.equal(x.agent.onIncoming(incoming(x.chat,'same','Hola')),false);
    assert.equal(x.agent.onIncoming(incoming('999@c.us','x','Other')),false);
    x.clock.tick(45000);await x.agent.drain();
    assert.equal(x.calls.length,1);
    assert.equal(x.db.countMessages(x.chat),1);
  }finally{x.agent.stop();x.close();}
});
test('Agent: manual outgoing reply cancels debounce and invalidates old drafts',async()=>{
  const x=setup();try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));
    x.clock.tick(20000);
    x.agent.onOutgoing(incoming(x.chat,'mine','Hola, cómo vas?'));
    x.clock.tick(120000);await x.agent.drain();
    assert.equal(x.calls.length,0);
    assert.equal(x.db.revision(x.chat),2);
  }finally{x.agent.stop();x.close();}
});
test('Agent: a message arriving during generation discards stale reply',async()=>{
  const deferredResponse=deferred();
  const x=setup({aiGenerate:async()=>deferredResponse.promise});try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));
    x.clock.tick(45000);
    assert.equal(x.calls.length,1);
    x.agent.onIncoming(incoming(x.chat,'b','Otra cosa'));
    deferredResponse.resolve(suggested);
    await x.agent.drain();
    assert.equal(x.notified.length,0);
    assert.equal(x.db.draftsFor(x.chat).length,0);
    x.clock.tick(45000);await x.agent.drain();
    assert.equal(x.notified.length,1);
  }finally{x.agent.stop();x.close();}
});
test('Agent: latest revision is not lost if its timer expires while old model is busy',async()=>{
  const first=deferred();let count=0;
  const x=setup({aiGenerate:async()=>{count++;return count===1?first.promise:suggested;}});
  try {
    x.agent.onIncoming(incoming(x.chat,'a','1'));
    x.clock.tick(45000);
    x.agent.onIncoming(incoming(x.chat,'b','2'));
    x.clock.tick(45000); // while initial request remains in flight
    assert.equal(x.calls.length,1);
    first.resolve(suggested);
    await x.agent.drain();
    await new Promise(r=>setImmediate(r));
    await x.agent.drain();
    assert.equal(x.calls.length,2);
    assert.equal(x.notified.length,1);
    assert.equal(x.db.draftsFor(x.chat)[0].revision,2);
  }finally{x.agent.stop();x.close();}
});
test('Agent: manual response during model call discards its output',async()=>{
  const def=deferred();const x=setup({aiGenerate:()=>def.promise});try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));x.clock.tick(45000);
    x.agent.onOutgoing(incoming(x.chat,'manual','Yo respondí'));
    def.resolve(suggested);await x.agent.drain();
    assert.equal(x.notified.length,0);assert.equal(x.db.draftsFor(x.chat).length,0);
  }finally{x.agent.stop();x.close();}
});
test('Agent: model says no reply; nothing is delivered',async()=>{
  const x=setup({aiGenerate:async()=>({should_reply:false,options:[]})});try {
    x.agent.onIncoming(incoming(x.chat,'a','Gracias'));
    x.clock.tick(45000);await x.agent.drain();
    assert.equal(x.notified.length,0);assert.equal(x.db.draftsFor(x.chat).length,0);
  }finally{x.agent.stop();x.close();}
});
test('Agent: failed self-chat delivery is persisted as failed, never delivered to contact',async()=>{
  const x=setup({deliver:async()=> ({status:'failed', whatsappId:null})});try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));x.clock.tick(45000);await x.agent.drain();
    assert.equal(x.db.draftsFor(x.chat)[0].status,'failed');
  }finally{x.agent.stop();x.close();}
});
test('Agent: restart never replays an existing message or old draft',async()=>{
  const x=setup();try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));x.clock.tick(45000);await x.agent.drain();
    x.agent.stop();
    const clock2=new Clock(); const calls2=[];
    const restored=new DatingAgent({db:x.db,config:agentConfig(),logger:quietLogger(),
      ai:{generate:async()=>{calls2.push(1);return suggested;}},
      drafts:{deliver:async()=>({status:'notified', whatsappId:'note-2'})},setTimer:clock2.setTimeout,clearTimer:clock2.clearTimeout});
    clock2.tick(180000);await restored.drain();
    assert.equal(calls2.length,0);
    restored.stop();
  }finally{x.close();}
});
test('Agent: fails closed if a notification becomes stale before sending',async()=>{
  let x;
  x=setup({deliver:async(draft,opts)=>{
    x.agent.onIncoming(incoming(x.chat,'new','New message'));
    return {status: opts.beforeSend() ? 'notified' : 'stale', whatsappId:'note-stale'};
  }});
  try {
    x.agent.onIncoming(incoming(x.chat,'a','Hola'));x.clock.tick(45000);await x.agent.drain();
    assert.equal(x.db.draftsFor(x.chat)[0].status,'stale');
  }finally{x.agent.stop();x.close();}
});
