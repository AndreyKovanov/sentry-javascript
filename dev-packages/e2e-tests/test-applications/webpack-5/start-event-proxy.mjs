import { startEventProxyServer } from '@sentry-internal/test-utils';

startEventProxyServer({
  port: 3031,
  proxyServerName: 'webpack-5',
});