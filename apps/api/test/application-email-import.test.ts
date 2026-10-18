import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findStage, parseEml } from '../src/email-import-parser.js';

test('reads a quoted-printable ISO-8859-1 email body without decoding attachments into the review text', async () => {
  const message = [
    'From: fictional@example.test', 'To: ruben@example.test', 'Message-ID: <fixture-1@example.test>', 'Date: Sun, 18 Oct 2026 10:00:00 +0000',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="part"', '',
    '--part', 'Content-Type: text/plain; charset="iso-8859-1"', 'Content-Transfer-Encoding: quoted-printable', '',
    'Hola Rub=E9n, queremos invitarte a una entrevista.',
    '--part', 'Content-Type: text/plain; name="private.txt"', 'Content-Disposition: attachment; filename="private.txt"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('attachment-only-secret', 'utf8').toString('base64'), '--part--', '',
  ].join('\r\n');
  const parsed = await parseEml(Buffer.from(message, 'latin1'));
  assert.match(parsed.text, /Rubén/);
  assert.match(parsed.text, /entrevista/);
  assert.doesNotMatch(parsed.text, /attachment-only-secret|private\.txt/);
  assert.equal(parsed.messageId, '<fixture-1@example.test>');
  assert.equal(parsed.messageDate, '2026-10-18T10:00:00.000Z');
});

test('multipart HTML alternatives are ignored, so scripts and remote resources never enter the review text', async () => {
  const message = [
    'From: fictional@example.test', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="alt"', '',
    '--alt', 'Content-Type: text/plain; charset="utf-8"', '', 'We would like to invite you to an interview.',
    '--alt', 'Content-Type: text/html; charset="utf-8"', '',
    '<p>We would like to invite you to an interview.</p><script>throw new Error("unsafe-script-marker")</script><img src="https://remote.example.test/tracker.png">', '--alt--', '',
  ].join('\r\n');
  const parsed = await parseEml(Buffer.from(message, 'utf8'));
  assert.match(parsed.text, /invite you to an interview/);
  assert.doesNotMatch(parsed.text, /unsafe-script-marker|remote\.example\.test|<img|<script/i);
});

test('stage detection returns only a short, visible evidence excerpt', () => {
  const result = findStage('Thank you for applying. We would like to invite you to an interview next week.');
  assert.equal(result.stage, 'INTERVIEW');
  assert.match(result.excerpt, /invite you to an interview/);
  assert.equal(findStage('We received your application.').stage, null);
});

test('rejection wording wins over offer vocabulary and positive offers remain detectable', () => {
  assert.equal(findStage('We have decided to offer the position to another candidate.').stage, 'REJECTED');
  assert.equal(findStage('We will not be moving forward to interview.').stage, 'REJECTED');
  assert.equal(findStage('No seguiremos con tu candidatura para esta oferta.').stage, 'REJECTED');
  assert.equal(findStage('We are pleased to offer you the role.').stage, 'OFFER');
});

test('rejects oversized messages before parsing', async () => {
  await assert.rejects(parseEml(new Uint8Array(1_000_001)), /EMAIL_FILE_TOO_LARGE/);
});
