import { createApp } from './server.js';

const profile = process.env.UCP_PROFILE_URL;
if (!profile) throw new Error('UCP_PROFILE_URL is required; see README for the hosted example profile');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]')
  .split(',').map((value) => value.trim());
if (allowedHosts.some((value) => !value || value.includes('*'))) {
  throw new Error('ALLOWED_HOSTS must contain explicit, nonempty hostnames');
}
const server = createApp({ profile, host, allowedHosts, token: process.env.BRIDGE_TOKEN }).listen(port, host, () => {
  console.log(`Shopify Catalog MCP bridge listening on ${host}:${port}`);
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('HTTP listener failed', error.code);
  process.exitCode = 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => { process.exitCode = 0; });
    server.closeIdleConnections();
    setTimeout(() => { server.closeAllConnections(); }, 10_000).unref();
  });
}
