import { test, expect } from 'vitest';
import { loadProxies, getProxyById, getDefaultProxy, formatProxyForPlaywright } from '../src/lib/proxy.js';
import type { ProxyStore } from '../src/types/proxy.js';

test('loadProxies - loads proxies from JSON', async () => {
  const store = await loadProxies();
  
  expect(store).toBeDefined();
  expect(store.proxies).toBeInstanceOf(Array);
  expect(store.proxies.length).toBeGreaterThan(0);
  expect(store.default).toBeDefined();
  expect(typeof store.default).toBe('string');
});

test('loadProxies - caches result', async () => {
  const store1 = await loadProxies();
  const store2 = await loadProxies();
  
  // Should be the same object reference
  expect(store1).toBe(store2);
});

test('getProxyById - returns proxy when found', async () => {
  const store = await loadProxies();
  const proxy = getProxyById(store, 'oxylabs-us-datacenter-1');
  
  expect(proxy).toBeDefined();
  expect(proxy?.id).toBe('oxylabs-us-datacenter-1');
  expect(proxy?.provider).toBe('oxylabs');
  expect(proxy?.type).toBe('datacenter');
});

test('getProxyById - returns null when not found', async () => {
  const store = await loadProxies();
  const proxy = getProxyById(store, 'non-existent-proxy');
  
  expect(proxy).toBeNull();
});

test('getDefaultProxy - returns default proxy', async () => {
  const store = await loadProxies();
  const proxy = getDefaultProxy(store);
  
  expect(proxy).toBeDefined();
  expect(proxy?.id).toBe(store.default);
});

test('formatProxyForPlaywright - converts proxy format', async () => {
  const store = await loadProxies();
  const proxy = getProxyById(store, 'oxylabs-us-datacenter-1');
  
  expect(proxy).toBeDefined();
  if (!proxy) return;
  
  const formatted = formatProxyForPlaywright(proxy);
  
  expect(formatted.server).toBe(proxy.url);
  expect(formatted.username).toBe(proxy.username);
  expect(formatted.password).toBe(proxy.password);
});