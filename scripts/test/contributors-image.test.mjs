import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avatarDataUri, avatarUrl, contributorsSvg, people } from '../lib/contributors-image.mjs';

const user = (login) => ({ login, type: 'User', avatar_url: `https://avatars.githubusercontent.com/u/${login.length}?v=4` });

test('only people are shown, in contribution order', () => {
  const list = [user('maintainer'), { login: 'dependabot[bot]', type: 'Bot', avatar_url: 'https://avatars.githubusercontent.com/in/29110?v=4' }, { type: 'Anonymous', name: 'someone', email: 'x@example.test' }, user('first-timer')];
  assert.deepEqual(people(list).map((entry) => entry.login), ['maintainer', 'first-timer']);
});

test('avatars are requested at double size from the GitHub avatar host only', () => {
  assert.equal(avatarUrl('https://avatars.githubusercontent.com/u/1?v=4'), 'https://avatars.githubusercontent.com/u/1?v=4&s=128');
  assert.throws(() => avatarUrl('https://evilgithubusercontent.com/u/1'), /Unexpected avatar host/);
  assert.throws(() => avatarUrl('http://avatars.githubusercontent.com/u/1'), /Unexpected avatar host/);
});

test('only raster avatar types are embedded', () => {
  assert.equal(avatarDataUri('image/png', new Uint8Array([1, 2, 3])), 'data:image/png;base64,AQID');
  assert.equal(avatarDataUri('image/jpeg; charset=binary', new Uint8Array([255])), 'data:image/jpeg;base64,/w==');
  assert.throws(() => avatarDataUri('image/svg+xml', new Uint8Array([60])), /Unexpected avatar type/);
  assert.throws(() => avatarDataUri(null, new Uint8Array()), /Unexpected avatar type/);
});

test('the grid wraps after twelve avatars and escapes logins', () => {
  const entries = Array.from({ length: 13 }, (_, index) => ({ login: index === 0 ? 'a<b>&"c\'' : `user-${index}`, dataUri: 'data:image/png;base64,AQID' }));
  const svg = contributorsSvg(entries);
  assert.match(svg, /^<svg [^>]*width="900" height="140" viewBox="0 0 900 140"/);
  assert.equal(svg.match(/<image /g)?.length, 13);
  assert.match(svg, /<title>a&lt;b&gt;&amp;&quot;c&apos;<\/title>/);
  assert.doesNotMatch(svg, /a<b>/);
  assert.match(svg, /translate\(0 76\)/);
});

test('a short list keeps the image as narrow as its avatars', () => {
  assert.match(contributorsSvg([{ login: 'solo', dataUri: 'data:image/png;base64,AQID' }, { login: 'duo', dataUri: 'data:image/png;base64,AQID' }]), /width="140" height="64"/);
});
