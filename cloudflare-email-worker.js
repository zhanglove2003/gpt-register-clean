function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function unauthorized() {
  return json({ error: 'unauthorized' }, 401);
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64);
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
}

function getBearerToken(request) {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : request.headers.get('x-mail-token') || '';
}

function assertAuthorized(request, env) {
  const expected = String(env.MAIL_API_TOKEN || '').trim();
  if (!expected) return false;
  return getBearerToken(request) === expected;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

async function streamToText(stream) {
  if (!stream) return '';
  return await new Response(stream).text();
}

async function createAddress(request, env) {
  const body = await readJson(request);
  const explicitAddress = normalizeAddress(body.address);
  const domain = normalizeDomain(body.domain || env.MAIL_DOMAIN);
  const name = normalizeName(body.name || explicitAddress.split('@')[0]);
  const address = explicitAddress || `${name}@${domain}`;

  if (!address.includes('@') || !name || !domain) {
    return json({ error: 'invalid address' }, 400);
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO mailboxes (address, created_at) VALUES (?, ?)'
  ).bind(address, Date.now()).run();

  return json({ address });
}

async function listMails(request, env) {
  const url = new URL(request.url);
  const address = normalizeAddress(url.searchParams.get('address') || url.searchParams.get('email'));
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 10));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  if (!address) {
    return json({ error: 'address is required' }, 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT
       id,
       address,
       sender,
       subject,
       raw,
       received_at AS createdAt
     FROM mails
     WHERE address = ?
     ORDER BY received_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).bind(address, limit, offset).all();

  const rows = (results || []).map((row) => ({
    id: row.id,
    address: row.address,
    from: row.sender,
    subject: row.subject || '',
    raw: row.raw || '',
    text: row.raw || '',
    content: row.raw || '',
    message: row.raw || '',
    createdAt: row.createdAt,
  }));

  return json({ results: rows, data: { results: rows } });
}

export default {
  async fetch(request, env) {
    if (!assertAuthorized(request, env)) {
      return unauthorized();
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/create-address' && request.method === 'POST') {
      return await createAddress(request, env);
    }
    if (url.pathname === '/api/mails' && request.method === 'GET') {
      return await listMails(request, env);
    }
    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },

  async email(message, env) {
    if (!env.DB) {
      message.setReject?.('D1 binding DB is missing');
      return;
    }

    const address = normalizeAddress(message.to);
    const sender = normalizeAddress(message.from);
    const subject = message.headers.get('subject') || '';
    const raw = await streamToText(message.raw);

    await env.DB.prepare(
      'INSERT INTO mails (address, sender, subject, raw, received_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(address, sender, subject, raw, Date.now()).run();
  },
};
