import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, nearToYocto } from './buy.ts';

test('nearToYocto is exact', () => {
  assert.equal(nearToYocto('1'), '1000000000000000000000000');
  assert.equal(nearToYocto('0.1'), '100000000000000000000000');
  assert.equal(nearToYocto('.003'), '3000000000000000000000');
  assert.equal(nearToYocto('1.000000000000000000000001'), '1000000000000000000000001');
  for (const bad of ['', '.', '0', '-1', '1e3', 'abc', '1.0000000000000000000000001']) assert.equal(nearToYocto(bad), null, bad);
});

test('estimateTokens: fee on first buy, cap at remaining', () => {
  const price = '10000000000000000000000'; // 0.01 NEAR per token
  assert.equal(estimateTokens(nearToYocto('1')!, price, false, 1e6), 100);
  assert.equal(estimateTokens(nearToYocto('1')!, price, true, 1e6), 99.675);
  assert.equal(estimateTokens(nearToYocto('1')!, price, false, 40), 40);
  assert.equal(estimateTokens(nearToYocto('0.002')!, price, true, 1e6), 0);
});
