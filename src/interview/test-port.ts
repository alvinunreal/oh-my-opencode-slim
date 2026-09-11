import { createServer, type Server } from 'node:http';

/**
 * Bind an OS-assigned port on localhost and keep the server listening.
 *
 * Tests hand `server` to the interview server factories (via their
 * optional `server` config) so the real server adopts the already-bound
 * listener instead of racing through a bind/close/bind TOCTOU window
 * between port discovery and the real bind.
 *
 * The placeholder 404 handler makes dashboard health probes fail fast
 * (non-OK response, no timeout wait), so a held port never looks like a
 * live dashboard to `tryBecomeDashboard`.
 */
export function bindFreePort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to bind a free port'));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}
