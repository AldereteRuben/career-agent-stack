import test from 'node:test';
import assert from 'node:assert/strict';
import {identityUrl,jobIdentity} from '../src/job-identity.js';

test('strong identity strips tracking only and never conflates requisitions',()=>{
  assert.equal(jobIdentity('https://careers.example.com/jobs/123?utm_source=feed&location=es#apply'),jobIdentity('https://careers.example.com/jobs/123?location=es'));
  assert.notEqual(jobIdentity('https://careers.example.com/jobs?id=123'),jobIdentity('https://careers.example.com/jobs?id=124'));
  assert.notEqual(jobIdentity('https://careers.example.com/jobs/123?location=es'),jobIdentity('https://careers.example.com/jobs/123?location=us'));
  assert.notEqual(jobIdentity('https://careers.example.com/jobs/123'),jobIdentity('https://other.example.com/jobs/123'));
  assert.equal(identityUrl('https://careers.example.com/jobs?b=2&a=1&fbclid=tracking'),'https://careers.example.com/jobs?a=1&b=2');
});
test('invalid or credentialed identities cannot enter shared groups',()=>{
  for(const value of ['javascript:alert(1)','http://careers.example.com/job','https://user:password@careers.example.com/job','not a URL']) assert.throws(()=>jobIdentity(value));
});
