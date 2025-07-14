export interface PaginationConfig {
    type: 'scroll' | 'numbered';
    loadMoreIndicator?: string;  // For scroll-based
    pattern?: string;           // For numbered pagination
}

export interface SiteConfig {
    domain: string;
    scraper: string;
    startPages: string[];
    scraping: {
        browser: {
            ignoreHttpsErrors: boolean;
            userAgent?: string;
            headers: Record<string, string>;
            headless?: boolean;
            args?: string[];
            viewport?: { width: number; height: number; } | null;
        };
    };
    proxy?: {
        strategy: 'none' | 'datacenter' | 'datacenter-to-residential' | 'residential-stable' | 'residential-rotating';
        geo: string;  // 2-letter ISO code: 'US', 'UK', etc.
        cooldownMinutes: number;  // Default: 30
        failureThreshold: number;  // Default: 2
        sessionLimit: number;  // Max concurrent sessions per site
    };
    timeout?: number;  // Navigation timeout in milliseconds (default: 10000)
}

export interface SitesConfig {
    sites: SiteConfig[];
}

export interface ProxyStrategyConfig {
    strategy: 'none' | 'datacenter' | 'datacenter-to-residential' | 'residential-stable' | 'residential-rotating';
    geo: string;  // 2-letter ISO code: 'US', 'UK', etc.
    cooldownMinutes: number;
    failureThreshold: number;
    sessionLimit: number;
}

export interface ProxyStrategiesStore {
    [domain: string]: ProxyStrategyConfig;
}