'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadConfig}=require('../src/config');

test('Configuration fails closed if DRAFT_ONLY is disabled',()=>{
  const original={...process.env};
  try{
    process.env.TEST_CONTACT_NUMBER='15551234567';
    process.env.OPENROUTER_API_KEY='fake';
    process.env.OPENROUTER_MODEL='openrouter/free';
    process.env.DRAFT_ONLY='false';
    assert.throws(()=>loadConfig(),/hard-locked/);
  }finally{process.env=original;}
});
