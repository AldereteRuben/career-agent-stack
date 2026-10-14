/**
 * Builds the README contributors image. contrib.rocks caches its image for days, so the repository renders its own.
 * Everything here is pure: the caller fetches the contributor list and the avatars.
 */

export const avatarSize = 64;
export const avatarGap = 12;
export const columns = 12;
const allowedAvatarTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** People only, in the API order (most contributions first): bots and anonymous entries are left out. */
export function people(contributors) {
  return contributors.filter((entry) => entry?.type === 'User' && typeof entry.login === 'string' && !entry.login.endsWith('[bot]') && typeof entry.avatar_url === 'string');
}

/** Requests a square avatar at twice the drawn size so it stays sharp on high-density screens. */
export function avatarUrl(url, size = avatarSize * 2) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'avatars.githubusercontent.com') throw new Error(`Unexpected avatar host: ${parsed.hostname}`);
  parsed.searchParams.set('s', String(size));
  return parsed.toString();
}

/** Inline data URI for an avatar; only common raster image types are embedded. */
export function avatarDataUri(contentType, bytes) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!allowedAvatarTypes.has(type)) throw new Error(`Unexpected avatar type: ${type || 'none'}`);
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

/**
 * SVG grid of round avatars. Avatars must already be data URIs: an SVG shown through <img> cannot load external images.
 * Each avatar keeps the login as its title so it shows on hover.
 */
export function contributorsSvg(entries) {
  const count = Math.max(entries.length, 1);
  const perRow = Math.min(count, columns);
  const rows = Math.ceil(count / columns);
  const width = perRow * avatarSize + (perRow - 1) * avatarGap;
  const height = rows * avatarSize + (rows - 1) * avatarGap;
  const radius = avatarSize / 2;
  const items = entries.map(({ login, dataUri }, index) => {
    const x = (index % columns) * (avatarSize + avatarGap);
    const y = Math.floor(index / columns) * (avatarSize + avatarGap);
    return `<g transform="translate(${x} ${y})"><title>${escapeXml(login)}</title><clipPath id="c${index}"><circle cx="${radius}" cy="${radius}" r="${radius}"/></clipPath><image width="${avatarSize}" height="${avatarSize}" clip-path="url(#c${index})" href="${escapeXml(dataUri)}"/><circle cx="${radius}" cy="${radius}" r="${radius - 0.5}" fill="none" stroke="#8a94a1" stroke-opacity="0.35"/></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escapeXml(entries.map((entry) => entry.login).join(', '))}</title>${items.join('')}</svg>\n`;
}
