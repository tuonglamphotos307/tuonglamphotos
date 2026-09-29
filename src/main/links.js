'use strict';

// Parses Google Drive / Docs links (or bare IDs) into { id, resourceKey, kind }.
// kind: 'folder' | 'file' | 'document' | 'spreadsheet' | 'presentation' | 'drawing' | 'unknown'

const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

const DOC_KINDS = {
  document: 'document',
  spreadsheets: 'spreadsheet',
  presentation: 'presentation',
  drawings: 'drawing',
  file: 'file',
};

function parseDriveLink(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (ID_RE.test(text) && !text.includes('.')) {
    return { id: text, resourceKey: null, kind: 'unknown' };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (!/(^|\.)google\.com$/.test(host) && !/(^|\.)googleusercontent\.com$/.test(host)) {
    return null;
  }

  const resourceKey = url.searchParams.get('resourcekey') || url.searchParams.get('resourceKey') || null;
  const parts = url.pathname.split('/').filter(Boolean);

  // /drive/folders/ID, /drive/u/0/folders/ID, /drive/mobile/folders/ID
  const folderIdx = parts.indexOf('folders');
  if (folderIdx !== -1 && parts[folderIdx + 1] && ID_RE.test(parts[folderIdx + 1])) {
    return { id: parts[folderIdx + 1], resourceKey, kind: 'folder' };
  }

  // /file/d/ID/..., /document/d/ID/..., /spreadsheets/d/ID/..., /document/u/0/d/ID
  const dIdx = parts.indexOf('d');
  if (dIdx !== -1 && parts[dIdx + 1] && ID_RE.test(parts[dIdx + 1])) {
    const kind = DOC_KINDS[parts[0]] || 'file';
    return { id: parts[dIdx + 1], resourceKey, kind };
  }

  // /open?id=ID, /uc?id=ID, /download?id=ID, /thumbnail?id=ID, /drive/folderview?id=ID
  const qid = url.searchParams.get('id');
  if (qid && ID_RE.test(qid)) {
    const kind = parts.includes('folderview') ? 'folder' : 'unknown';
    return { id: qid, resourceKey, kind };
  }

  return null;
}

// Splits a pasted blob (one or many links separated by whitespace/commas) into parsed links, de-duplicated.
function parseManyLinks(blob) {
  const seen = new Set();
  const out = [];
  for (const token of String(blob || '').split(/[\s,;]+/)) {
    const parsed = parseDriveLink(token);
    if (parsed && !seen.has(parsed.id)) {
      seen.add(parsed.id);
      out.push({ ...parsed, input: token });
    }
  }
  return out;
}

module.exports = { parseDriveLink, parseManyLinks };
