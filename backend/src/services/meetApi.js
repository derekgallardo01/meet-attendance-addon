const log = require('../lib/logger');

async function meetGet(path, token, retries = 2) {
  const url = `https://meet.googleapis.com/v2/${path}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) return resp.json();
    const body = await resp.text();
    if (resp.status >= 500 && attempt < retries) {
      log.warn('meet api transient error, retrying', { status: resp.status, attempt });
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`Meet API ${resp.status}: ${body}`);
  }
}

// Fetch all pages for a list endpoint. Returns the combined array from the given response key.
async function meetGetAll(path, token, responseKey) {
  const items = [];
  let pageToken = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const url = pageToken ? `${path}${separator}pageToken=${pageToken}` : path;
    const data = await meetGet(url, token);
    if (data[responseKey]) items.push(...data[responseKey]);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return items;
}

module.exports = { meetGet, meetGetAll };
