#!/usr/bin/env node
// Renders the README contributors image (used by .github/workflows/contributors.yml).
//   GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=… node scripts/contributors-image.mjs <output.svg>
// Reads only public data: the repository's contributor list and the contributors' public avatars.
import { writeFile } from 'node:fs/promises';
import { avatarDataUri, avatarUrl, contributorsSvg, people } from './lib/contributors-image.mjs';

const output = process.argv[2];
const repository = process.env.GITHUB_REPOSITORY;
if (!output || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
  console.error('Usage: GITHUB_REPOSITORY=owner/repo [GITHUB_TOKEN=…] node scripts/contributors-image.mjs <output.svg>');
  process.exit(2);
}
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };

async function get(url, init) {
  const response = await globalThis.fetch(url, { ...init, signal: globalThis.AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${new URL(url).pathname}`);
  return response;
}

const contributors = [];
for (let page = 1; page <= 10; page += 1) {
  const batch = await (await get(`https://api.github.com/repos/${repository}/contributors?per_page=100&page=${page}`, { headers })).json();
  contributors.push(...batch);
  if (batch.length < 100) break;
}
const entries = [];
for (const person of people(contributors)) {
  const response = await get(avatarUrl(person.avatar_url));
  entries.push({ login: person.login, dataUri: avatarDataUri(response.headers.get('content-type'), new Uint8Array(await response.arrayBuffer())) });
}
if (!entries.length) throw new Error('No contributors found; refusing to publish an empty image.');
await writeFile(output, contributorsSvg(entries));
console.log(`Wrote ${output} with ${entries.length} contributor(s): ${entries.map((entry) => entry.login).join(', ')}`);
