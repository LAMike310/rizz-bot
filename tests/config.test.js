'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadConfig}=require('../src/config');

test('PROD selects the debounce interval',()=>{
  const original={...process.env};
  try{
    process.env.TEST_CONTACT_NUMBER='15551234567';
    process.env.OPENROUTER_API_KEY='fake';
    process.env.OPENROUTER_MODEL='openrouter/free';
    process.env.DRAFT_ONLY='true';
    delete process.env.PROD;
    assert.equal(loadConfig().debounceMs,5000);
    process.env.PROD='false';
    assert.equal(loadConfig().debounceMs,5000);
    process.env.PROD='true';
    assert.equal(loadConfig().debounceMs,45000);
  }finally{process.env=original;}
});

test('Approved sending stays off unless both flags explicitly allow it',()=>{
  const original={...process.env};
  try{
    process.env.TEST_CONTACT_NUMBER='15551234567';
    process.env.OPENROUTER_API_KEY='fake';
    process.env.OPENROUTER_MODEL='openrouter/free';
    delete process.env.APPROVED_SEND_ENABLED;
    process.env.DRAFT_ONLY='false';
    assert.equal(loadConfig().draftOnly,false);
    assert.equal(loadConfig().approvedSendEnabled,false);
    assert.equal(loadConfig().draftTtlMinutes,120);
    process.env.DRAFT_ONLY='true';
    process.env.APPROVED_SEND_ENABLED='true';
    assert.equal(loadConfig().approvedSendEnabled,true);
    assert.equal(loadConfig().draftOnly,true);
    assert.equal(loadConfig().voiceSanityTestEnabled,false);
    assert.equal(loadConfig().openrouterSttModel,'openai/whisper-large-v3-turbo');
    assert.equal(loadConfig().voiceTestMaxSeconds,30);
    assert.equal(loadConfig().voiceTestMaxBytes,5000000);
    assert.equal(loadConfig().voiceSttTimeoutMs,30000);
    assert.equal(loadConfig().incomingVoiceEnabled,false);
    assert.equal(loadConfig().incomingVoiceLanguage,'es');
    assert.equal(loadConfig().incomingVoiceMaxSeconds,120);
    assert.equal(loadConfig().incomingVoiceMaxBytes,8000000);
  }finally{process.env=original;}
});
