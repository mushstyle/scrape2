import type { SiteConfig } from '../types/site-config-types.js';
import { getSiteById } from '../providers/etl-api.js';
import { loadProxyStrategies } from '../providers/local-db.js';
import type { ApiSiteMetadata } from '../types/siteScrapingConfig.js';
import { extractDomain } from '../utils/url-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('site-config');

/**
 * Fetches site configuration for a given domain from the remote API
 * and merges proxy strategy from local proxy-strategies.json.
 * @param domainOrUrl The domain or a URL containing the domain.
 * @returns A Promise resolving to the SiteConfig object.
 */
export async function getSiteConfig(domainOrUrl: string): Promise<SiteConfig> {
    const cleanDomain = extractDomain(domainOrUrl);

    try {
        const apiData: ApiSiteMetadata = await getSiteById(cleanDomain);

        if (!apiData.scrapeConfig) {
            throw new Error(`API response for ${cleanDomain} is missing 'scrapeConfig'.`);
        }
        if (!apiData.scrapeConfig.browser) {
            // If browser config is entirely missing from API, we might provide a default empty one
            // or let it be undefined if SiteConfig allows scraping.browser to be optional.
            // For now, assuming API should provide at least an empty browser object if scrapeConfig exists.
            apiData.scrapeConfig.browser = {} as any; // Or handle more gracefully
            log.error(`API response for ${cleanDomain} is missing 'scrapeConfig.browser'. Using defaults.`);
        }

        const siteConfig: SiteConfig = {
            domain: apiData._id,
            scraper: apiData.scrapeConfig.scraperFile || `${apiData._id}.ts`,
            startPages: apiData.scrapeConfig.startPages || [],
            scraping: {
                browser: {
                    ignoreHttpsErrors: apiData.scrapeConfig.browser?.ignoreHttpsErrors ?? false,
                    userAgent: apiData.scrapeConfig.browser?.userAgent ?? undefined,
                    headless: apiData.scrapeConfig.browser?.headless ?? undefined,
                    headers: apiData.scrapeConfig.browser?.headers ?? {},
                    args: apiData.scrapeConfig.browser?.args ?? undefined, // Map args
                    viewport: apiData.scrapeConfig.browser?.viewport ?? undefined, // Map viewport
                },
            },
        };

        // Load and merge proxy strategies
        const proxyStrategies = await loadProxyStrategies();
        
        // Check if proxy strategies are valid
        if (!proxyStrategies || typeof proxyStrategies !== 'object') {
            throw new Error('Invalid proxy-strategies.json: must be an object');
        }
        
        // Look for domain-specific strategy or fall back to default
        const proxyStrategy = proxyStrategies[cleanDomain] || proxyStrategies['default'];
        
        if (!proxyStrategy) {
            throw new Error(`No proxy strategy found for ${cleanDomain} and no default strategy available`);
        }
        
        // Validate proxy strategy structure
        if (!proxyStrategy.strategy || !proxyStrategy.geo || 
            typeof proxyStrategy.cooldownMinutes !== 'number' || 
            typeof proxyStrategy.failureThreshold !== 'number' ||
            typeof proxyStrategy.sessionLimit !== 'number') {
            throw new Error(`Invalid proxy strategy structure for ${cleanDomain}: missing required fields`);
        }
        
        // Merge proxy strategy into site config
        siteConfig.proxy = {
            strategy: proxyStrategy.strategy,
            geo: proxyStrategy.geo,
            cooldownMinutes: proxyStrategy.cooldownMinutes,
            failureThreshold: proxyStrategy.failureThreshold,
            sessionLimit: proxyStrategy.sessionLimit
        };
        
        log.debug(`Applied proxy strategy for ${cleanDomain}: ${proxyStrategy.strategy}`);

        return siteConfig;

    } catch (error) {
        log.error(`Error fetching site config for ${cleanDomain} from API:`, { error });
        // Re-throw or handle error as appropriate for callers
        throw new Error(`Failed to get configuration for domain: ${cleanDomain}. Reason: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Extracts the first start page URL from the SiteConfig.
 */
export function getFirstStartPageUrl(config: SiteConfig): string {
    if (!config.startPages || config.startPages.length === 0) {
        throw new Error(`No start pages configured for domain: ${config.domain}`);
    }
    // Now correctly accesses the first element which is a string URL
    return config.startPages[0];
}

/**
 * Add start pages to a site's configuration
 * @param domain The domain to update
 * @param urls URLs to add (duplicates will be ignored)
 */
export async function addStartPages(domain: string, urls: string[]): Promise<void> {
    const cleanDomain = extractDomain(domain);
    
    try {
        // Get current config
        const currentConfig = await getSiteConfig(cleanDomain);
        const existingUrls = new Set(currentConfig.startPages || []);
        
        // Add new URLs (avoid duplicates)
        urls.forEach(url => existingUrls.add(url));
        
        // Update via API
        const { updateSiteScrapingConfig } = await import('../providers/etl-api.js');
        await updateSiteScrapingConfig(cleanDomain, {
            scrapeConfig: {
                startPages: Array.from(existingUrls)
            }
        });
        
        log.normal(`Added ${urls.length} start pages to ${cleanDomain}`);
    } catch (error) {
        log.error(`Failed to add start pages to ${cleanDomain}`, { error });
        throw error;
    }
}

/**
 * Replace all start pages for a site
 * @param domain The domain to update
 * @param urls New URLs to set as start pages
 */
export async function replaceStartPages(domain: string, urls: string[]): Promise<void> {
    const cleanDomain = extractDomain(domain);
    
    try {
        // Update via API
        const { updateSiteScrapingConfig } = await import('../providers/etl-api.js');
        await updateSiteScrapingConfig(cleanDomain, {
            scrapeConfig: {
                startPages: urls
            }
        });
        
        log.normal(`Replaced start pages for ${cleanDomain} with ${urls.length} new URLs`);
    } catch (error) {
        log.error(`Failed to replace start pages for ${cleanDomain}`, { error });
        throw error;
    }
}

/**
 * Remove specific start pages from a site
 * @param domain The domain to update
 * @param urlsToRemove URLs to remove
 */
export async function removeStartPages(domain: string, urlsToRemove: string[]): Promise<void> {
    const cleanDomain = extractDomain(domain);
    
    try {
        // Get current config
        const currentConfig = await getSiteConfig(cleanDomain);
        const existingUrls = new Set(currentConfig.startPages || []);
        
        // Remove specified URLs
        urlsToRemove.forEach(url => existingUrls.delete(url));
        
        // Update via API
        const { updateSiteScrapingConfig } = await import('../providers/etl-api.js');
        await updateSiteScrapingConfig(cleanDomain, {
            scrapeConfig: {
                startPages: Array.from(existingUrls)
            }
        });
        
        log.normal(`Removed ${urlsToRemove.length} start pages from ${cleanDomain}`);
    } catch (error) {
        log.error(`Failed to remove start pages from ${cleanDomain}`, { error });
        throw error;
    }
}