export interface Proxy {
  id: string;
  provider: string;
  type: 'residential' | 'datacenter';
  rotatingEndpoint?: boolean;
  geo: string;
  url: string;
  username: string;
  password: string;
}

export interface ProxyStore {
  proxies: Proxy[];
  default: string;
}

export interface PlaywrightProxy {
  server: string;
  username: string;
  password: string;
}