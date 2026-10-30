import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyResponseError,
  parseErrorBody,
  retryAfterMs,
  isQuotaDetail,
  LlmError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
} from '../lib/errors.js';
import { isSwitchableError, DEFAULT_SWITCH_CODES } from '../lib/pool.js';

test('issue #547: parseErrorBody extracts nested envelope fields', () => {
  // OpenAI envelope
  const openAi = JSON.stringify({
    error: {
      message: 'Rate limit exceeded for requests',
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
    },
  });
  const p1 = parseErrorBody(openAi);
  assert.equal(p1.message, 'Rate limit exceeded for requests');
  assert.equal(p1.type, 'rate_limit_error');
  assert.equal(p1.code, 'rate_limit_exceeded');

  // Anthropic envelope
  const anthropic = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'Prompt is too long for the model context window',
    },
  });
  const p2 = parseErrorBody(anthropic);
  assert.equal(p2.message, 'Prompt is too long for the model context window');
  assert.equal(p2.type, 'invalid_request_error');

  // Google / Gemini envelope with details
  const gemini = JSON.stringify({
    error: {
      code: 429,
      message: 'Resource has been exhausted (e.g. check quota).',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ reason: 'RATE_LIMIT_EXCEEDED', message: 'Quota exceeded for inference' }],
    },
  });
  const p3 = parseErrorBody(gemini);
  assert.equal(p3.code, '429');
  // status is string 'RESOURCE_EXHAUSTED'
  assert.equal(p3.code, '429');
  assert.ok(p3.message.includes('Resource has been exhausted'));

  // Plain string error
  const p4 = parseErrorBody('Simple text failure');
  assert.equal(p4.message, 'Simple text failure');
});

test('issue #547: retryAfterMs parses seconds and HTTP dates precisely', () => {
  const now = 1700000000000;

  // 1. Seconds as string or number
  assert.equal(retryAfterMs('60', now), 60000);
  assert.equal(retryAfterMs('1.5', now), 1500);
  assert.equal(retryAfterMs('Retry-After: 45', now), 45000);

  // 2. Fetch Headers API mock
  const headers = new Map([['retry-after', '120']]);
  assert.equal(retryAfterMs(headers, now), 120000);

  // 3. Object headers
  assert.equal(retryAfterMs({ 'Retry-After': '30' }, now), 30000);
  assert.equal(retryAfterMs({ 'x-ratelimit-reset-after': '15' }, now), 15000);

  // 4. RFC 1123 HTTP-Date format
  const futureDate = new Date(now + 90000).toUTCString();
  assert.equal(retryAfterMs(futureDate, now), 90000);

  // 5. Invalid / missing returns undefined
  assert.equal(retryAfterMs(null, now), undefined);
  assert.equal(retryAfterMs('', now), undefined);
  assert.equal(retryAfterMs('invalid-date-string', now), undefined);
});

test('issue #547: isQuotaDetail detects quota and balance depletion phrases', () => {
  assert.equal(isQuotaDetail('insufficient_quota: you exceeded your current quota'), true);
  assert.equal(isQuotaDetail('credit balance is too low to complete the request'), true);
  assert.equal(isQuotaDetail('monthly limit reached, please upgrade'), true);
  assert.equal(isQuotaDetail('rate limit 5 requests per second exceeded'), false);
});

test('issue #547: classifyResponseError produces canonical typed LlmError', () => {
  // Context window exceeded => surface, never switch
  const errContext = classifyResponseError(
    400,
    JSON.stringify({ error: { message: 'Maximum context length exceeded: 8192 tokens' } }),
    null
  );
  assert.ok(errContext instanceof LlmError);
  assert.equal(errContext.code, CONTEXT_WINDOW_EXCEEDED_CODE);
  assert.equal(errContext.status, 400);
  assert.equal(isSwitchableError({ body: errContext.message, status: 400 }), false);

  // Quota exceeded
  const errQuota = classifyResponseError(
    429,
    JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details' } }),
    { 'retry-after': '3600' }
  );
  assert.ok(errQuota.code === QUOTA_EXCEEDED_CODE || errQuota.code === ACCOUNT_QUOTA_EXCEEDED_CODE);
  assert.equal(errQuota.providerRetryAfterMs, 3600000);
  assert.equal(isSwitchableError({ body: errQuota.message, status: 429 }), true);

  // Rate limit
  const errRate = classifyResponseError(
    429,
    JSON.stringify({ error: { message: 'Too many requests, slow down' } }),
    { 'retry-after': '5' }
  );
  assert.equal(errRate.code, 'RATE_LIMIT');
  assert.equal(errRate.providerRetryAfterMs, 5000);
  assert.equal(isSwitchableError({ body: errRate.message, status: 429 }), true);

  // Auth / invalid credentials
  const errAuth = classifyResponseError(
    401,
    JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
    null
  );
  assert.equal(errAuth.code, INVALID_CREDENTIAL_CODE);
  assert.equal(isSwitchableError({ body: errAuth.message, status: 401 }), true);

  // Server error
  const errServer = classifyResponseError(
    503,
    JSON.stringify({ error: { message: 'Service Unavailable' } }),
    null
  );
  assert.equal(errServer.code, 'SERVER');
  assert.equal(isSwitchableError({ body: errServer.message, status: 503 }), true);

  // Timeout
  const errTimeout = classifyResponseError(
    504,
    'Gateway Timeout after 30000ms',
    null
  );
  assert.equal(errTimeout.code, 'TIMEOUT');
  assert.equal(isSwitchableError({ message: errTimeout.message, status: 504 }), true);
});

