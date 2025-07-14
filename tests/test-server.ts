import { serve } from 'bun';

/**
 * Simple test server for integration tests
 */
export function createTestServer(port: number = 0) {
  const server = serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      
      switch (url.pathname) {
        case '/':
          return new Response('<html><head><title>Test Page</title></head><body>Hello Test</body></html>', {
            headers: { 'Content-Type': 'text/html' }
          });
        
        case '/json':
          return new Response(JSON.stringify({ message: 'test', timestamp: Date.now() }), {
            headers: { 'Content-Type': 'application/json' }
          });
        
        case '/echo-headers':
          return new Response(JSON.stringify(Object.fromEntries(req.headers.entries())), {
            headers: { 'Content-Type': 'application/json' }
          });
        
        default:
          return new Response('Not Found', { status: 404 });
      }
    }
  });

  return {
    port: server.port,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop()
  };
}