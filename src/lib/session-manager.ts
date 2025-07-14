import { logger } from './logger.js';
import { createSession as createBrowserbaseSession } from '../providers/browserbase.js';
import { createSession as createLocalSession } from '../providers/local-browser.js';
import type { SessionStats } from '../types/orchestration.js';

const log = logger.createContext('session-manager');

interface Session {
  id: string;
  provider: 'browserbase' | 'local';
  domain?: string;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
  itemCount: number;
  proxyType?: 'residential' | 'datacenter' | 'none';
  proxyId?: string;
  proxyGeo?: string;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private sessionLimit: number;
  private provider: 'browserbase' | 'local';
  
  constructor(options: { sessionLimit?: number; provider?: 'browserbase' | 'local' } = {}) {
    this.sessionLimit = options.sessionLimit || 5;
    this.provider = options.provider || 'browserbase';
  }
  
  /**
   * Get all active sessions
   */
  async getActiveSessions(): Promise<string[]> {
    const activeSessions = Array.from(this.sessions.entries())
      .filter(([_, session]) => session.isActive)
      .map(([id]) => id);
    
    log.debug(`Found ${activeSessions.length} active sessions`);
    return activeSessions;
  }
  
  /**
   * Create a new session
   */
  async createSession(options: { domain?: string; proxy?: any } = {}): Promise<string> {
    // Check if we've reached the session limit
    const activeSessions = await this.getActiveSessions();
    if (activeSessions.length >= this.sessionLimit) {
      throw new Error(`Session limit (${this.sessionLimit}) reached`);
    }
    
    try {
      let sessionId: string;
      
      if (this.provider === 'browserbase') {
        const session = await createBrowserbaseSession({ proxy: options.proxy });
        sessionId = session.browserbase!.id;
      } else {
        // For local sessions, generate a unique ID
        sessionId = `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const session = await createLocalSession({ proxy: options.proxy });
      }
      
      // Store session metadata
      this.sessions.set(sessionId, {
        id: sessionId,
        provider: this.provider,
        domain: options.domain,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        isActive: true,
        itemCount: 0,
        proxyType: options.proxy ? this.getProxyType(options.proxy) : 'none',
        proxyId: options.proxy?.id,
        proxyGeo: options.proxy?.geo
      });
      
      log.normal(`Created ${this.provider} session ${sessionId}`);
      return sessionId;
    } catch (error) {
      log.error(`Failed to create session`, { error });
      throw error;
    }
  }
  
  /**
   * Destroy a session
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.debug(`Session ${sessionId} not found`);
      return;
    }
    
    // Mark as inactive
    session.isActive = false;
    this.sessions.delete(sessionId);
    
    log.normal(`Destroyed session ${sessionId}`);
  }
  
  /**
   * Get session statistics for load balancing
   */
  getSessionStats(sessionId: string): SessionStats | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    
    return {
      sessionId: session.id,
      domain: session.domain,
      itemCount: session.itemCount,
      lastUsed: session.lastUsedAt,
      isActive: session.isActive
    };
  }
  
  /**
   * Get all session statistics
   */
  getAllSessionStats(): SessionStats[] {
    return Array.from(this.sessions.values()).map(session => ({
      sessionId: session.id,
      domain: session.domain,
      itemCount: session.itemCount,
      lastUsed: session.lastUsedAt,
      isActive: session.isActive
    }));
  }
  
  /**
   * Update session usage
   */
  updateSessionUsage(sessionId: string, incrementItemCount: boolean = true): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedAt = new Date();
      if (incrementItemCount) {
        session.itemCount++;
      }
    }
  }
  
  /**
   * Refresh sessions (health check)
   */
  async refreshSessions(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    
    for (const session of sessions) {
      // Check if session has been idle for more than 5 minutes
      const idleTime = Date.now() - session.lastUsedAt.getTime();
      if (idleTime > 5 * 60 * 1000) {
        log.normal(`Session ${session.id} idle for ${Math.round(idleTime / 1000)}s, marking as inactive`);
        await this.destroySession(session.id);
      }
    }
  }
  
  /**
   * Get session limit
   */
  getSessionLimit(): number {
    return this.sessionLimit;
  }
  
  /**
   * Set session limit
   */
  setSessionLimit(limit: number): void {
    this.sessionLimit = limit;
    log.normal(`Session limit set to ${limit}`);
  }
  
  /**
   * Get proxy type from proxy object
   */
  private getProxyType(proxy: any): 'residential' | 'datacenter' | 'none' {
    if (!proxy) return 'none';
    if (proxy.type === 'residential') return 'residential';
    if (proxy.type === 'datacenter') return 'datacenter';
    return 'none';
  }
}