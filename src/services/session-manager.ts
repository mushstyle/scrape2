import { logger } from '../utils/logger.js';
import { createBrowserbaseSession, createLocalSession, terminateSession } from '../drivers/browser.js';
import type { Session } from '../types/session.js';
import type { SessionStats } from '../types/orchestration.js';

const log = logger.createContext('session-manager');

interface SessionMetadata {
  session: Session;
  domain?: string;
  proxy?: any;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
  itemCount: number;
}

/**
 * Manages browser sessions properly - stores actual Session objects
 * This is the correct implementation that works with the architecture
 */
export class SessionManager {
  private sessions: Map<string, SessionMetadata> = new Map();
  private sessionLimit: number;
  private provider: 'browserbase' | 'local';
  
  constructor(options: { sessionLimit?: number; provider?: 'browserbase' | 'local' } = {}) {
    this.sessionLimit = options.sessionLimit || 5;
    this.provider = options.provider || 'browserbase';
    log.debug(`Initialized with provider: ${this.provider}, limit: ${this.sessionLimit}`);
  }
  
  /**
   * Get all active sessions (returns actual Session objects)
   */
  async getActiveSessions(): Promise<Session[]> {
    const activeSessions = Array.from(this.sessions.values())
      .filter(metadata => metadata.isActive)
      .map(metadata => metadata.session);
    
    log.debug(`Found ${activeSessions.length} active sessions`);
    return activeSessions;
  }
  
  /**
   * Create one or more sessions
   * @param options - Single options object or array of options
   * @returns Single session or array of sessions
   */
  async createSession(options: { domain?: string; proxy?: any } | Array<{ domain?: string; proxy?: any }> = {}): Promise<Session | Session[]> {
    // If single options object, convert to array for unified processing
    const isArray = Array.isArray(options);
    const optionsArray = isArray ? options : [options];
    
    // Check if we have capacity for all requested sessions
    const activeSessions = await this.getActiveSessions();
    const availableSlots = this.sessionLimit - activeSessions.length;
    
    // If requesting more than available, only create what we can
    const sessionsToCreate = Math.min(optionsArray.length, availableSlots);
    if (sessionsToCreate === 0) {
      log.normal(`No available slots (${activeSessions.length}/${this.sessionLimit} in use)`);
      return isArray ? [] : undefined as any;
    }
    
    if (sessionsToCreate < optionsArray.length) {
      log.normal(`Requested ${optionsArray.length} sessions but only ${availableSlots} slots available. Creating ${sessionsToCreate} sessions.`);
    }
    
    // Only process the options we can actually create
    const optionsToProcess = optionsArray.slice(0, sessionsToCreate);
    
    // Create all sessions in parallel
    const sessionPromises = optionsToProcess.map(async (opt) => {
      try {
        let session: Session;
        
        if (this.provider === 'browserbase') {
          session = await createBrowserbaseSession({ proxy: opt.proxy });
        } else {
          session = await createLocalSession({ proxy: opt.proxy });
        }
        
        // Get session ID
        const sessionId = this.getSessionId(session);
        
        // Store session with metadata
        this.sessions.set(sessionId, {
          session,
          domain: opt.domain,
          proxy: opt.proxy,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          isActive: true,
          itemCount: 0
        });
        
        // Create concise log with proxy info
        const proxyInfo = opt.proxy ? 
          (opt.proxy.type || 'proxy') : 
          'no-proxy';
        const domainInfo = opt.domain ? ` for ${opt.domain}` : '';
        log.normal(`${this.provider}[${sessionId.substring(0, 8)}...] ${proxyInfo}${domainInfo}`);
        
        return session;
      } catch (error) {
        log.error(`Failed to create session`, { error });
        throw error;
      }
    });
    
    // Wait for all sessions to be created
    const sessions = await Promise.all(sessionPromises);
    
    // Return single session or array based on input
    return isArray ? sessions : sessions[0];
  }
  
  /**
   * Get session ID from Session object
   */
  private getSessionId(session: Session): string {
    if (session.provider === 'browserbase') {
      return session.browserbase!.id;
    } else {
      // For local sessions, we need a stable ID
      // This is a temporary solution - ideally local sessions should have IDs too
      return `local-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
  }
  
  /**
   * Destroy a session
   */
  async destroySession(sessionId: string): Promise<void> {
    const metadata = this.sessions.get(sessionId);
    if (!metadata) {
      log.debug(`Session ${sessionId} not found`);
      return;
    }
    
    try {
      // Use the driver's terminateSession function
      await terminateSession(metadata.session);
      
      // Remove from our tracking
      this.sessions.delete(sessionId);
      
      log.normal(`Destroyed ${sessionId.substring(0, 8)}...`);
    } catch (error) {
      log.error(`Failed to destroy session ${sessionId}`, { error });
      // Remove from tracking even if cleanup failed
      this.sessions.delete(sessionId);
    }
  }
  
  /**
   * Destroy a session by Session object
   */
  async destroySessionByObject(session: Session): Promise<void> {
    // Find the session in our map
    for (const [id, metadata] of this.sessions.entries()) {
      if (metadata.session === session) {
        await this.destroySession(id);
        return;
      }
    }
    
    // If not found in our tracking, still try to clean it up
    try {
      await terminateSession(session);
    } catch (error) {
      log.debug(`Failed to cleanup untracked session`, error);
    }
  }
  
  /**
   * Get session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId)?.session;
  }
  
  /**
   * Update session usage
   */
  updateSessionUsage(sessionId: string, itemCount: number = 1): void {
    const metadata = this.sessions.get(sessionId);
    if (metadata) {
      metadata.lastUsedAt = new Date();
      metadata.itemCount += itemCount;
    }
  }
  
  /**
   * Get session statistics
   */
  getStats(): SessionStats {
    const entries = Array.from(this.sessions.values());
    const activeSessions = entries.filter(m => m.isActive);
    
    return {
      totalSessions: entries.length,
      activeSessions: activeSessions.length,
      totalItemsProcessed: entries.reduce((sum, m) => sum + m.itemCount, 0),
      averageItemsPerSession: activeSessions.length > 0 
        ? entries.reduce((sum, m) => sum + m.itemCount, 0) / activeSessions.length 
        : 0
    };
  }
  
  /**
   * Destroy all sessions
   */
  async destroyAllSessions(): Promise<void> {
    log.normal(`Destroying all ${this.sessions.size} sessions...`);
    
    const destroyPromises = Array.from(this.sessions.keys()).map(id => 
      this.destroySession(id).catch(error => 
        log.debug(`Failed to destroy session ${id}`, error)
      )
    );
    
    await Promise.all(destroyPromises);
    this.sessions.clear();
  }
  
  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(m => m.isActive).length;
  }
}