import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeSignature } from '../src/stripe.js';

const secret = 'whsec_test';
const body = '{"id":"evt_1"}';
const sign = (t, s = secret, b = body) => `t=${t},v1=${createHmac('sha256', s).update(`${t}.${b}`).digest('hex')}`;
const now = 1_800_000_000;

test('accepts a correctly signed webhook', async () => {
  assert.equal(await verifyStripeSignature(body, sign(now), secret, now), true);
});
test('rejects a wrong secret, a changed body, and an old timestamp', async () => {
  assert.equal(await verifyStripeSignature(body, sign(now, 'whsec_other'), secret, now), false);
  assert.equal(await verifyStripeSignature(body + ' ', sign(now), secret, now), false);
  assert.equal(await verifyStripeSignature(body, sign(now - 3600), secret, now), false);
});
test('rejects missing or junk headers', async () => {
  assert.equal(await verifyStripeSignature(body, '', secret, now), false);
  assert.equal(await verifyStripeSignature(body, 'v1=abc', secret, now), false);
  assert.equal(await verifyStripeSignature(body, null, secret, now), false);
});
