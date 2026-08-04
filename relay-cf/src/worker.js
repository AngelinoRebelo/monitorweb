const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function unauthorized() {
  return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: env.SERVICE_NAME || 'monitorweb-relay' });
    }

    if (request.method === 'POST' && url.pathname === '/v1/fetch') {
      const secret = env.RELAY_SECRET || '';
      if (!secret) {
        return Response.json({ ok: false, error: 'RELAY_SECRET não configurado' }, { status: 500 });
      }

      const header = request.headers.get('authorization') || '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const alt = request.headers.get('x-relay-secret') || '';
      if (token !== secret && alt !== secret) return unauthorized();

      let payload;
      try {
        payload = await request.json();
      } catch {
        return Response.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
      }

      const target = String(payload?.url || '').trim();
      const accept = String(payload?.accept || '').trim();
      try {
        const parsed = new URL(target);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return Response.json({ ok: false, error: 'URL inválida' }, { status: 400 });
        }
      } catch {
        return Response.json({ ok: false, error: 'URL inválida' }, { status: 400 });
      }

      const started = Date.now();
      try {
        const upstream = await fetch(target, {
          redirect: 'follow',
          headers: {
            'User-Agent': USER_AGENT,
            Accept:
              accept ||
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            Referer: `${new URL(target).origin}/`,
          },
        });
        const buf = new Uint8Array(await upstream.arrayBuffer());
        return Response.json({
          ok: upstream.ok,
          status: upstream.status,
          statusText: upstream.statusText,
          contentType: upstream.headers.get('content-type') || 'application/octet-stream',
          elapsedMs: Date.now() - started,
          bodyBase64: bytesToBase64(buf),
          bytes: buf.length,
          relayRegion: 'cloudflare',
          colo: request.cf?.colo || null,
          placement: 'aws:sa-east-1',
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err?.message || String(err),
          },
          { status: 502 }
        );
      }
    }

    return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
  },
};
