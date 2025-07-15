import { logger } from '../utils/logger.js';
import { createBrowserbaseSession, createLocalSession, terminateSession } from '../drivers/browser.js';
import type { Session } from '../types/session.js';
import type { SessionStats } from '../types/orchestration.js';

const log = logger.createContext('session-manager');

interface SessionMetadata {
  session: Session;
  domain?: string;
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
   * Create a new session and return the Session object
   */
  async createSession(options: { domain?: string; proxy?: any } = {}): Promise<Session> {
    // Check if we've reached the session limit
    const activeSessions = await this.getActiveSessions();
    if (activeSessions.length >= this.sessionLimit) {
      throw new Error(`Session limit (${this.sessionLimit}) reached`);
    }
    
    try {
      let session: Session;
      
      if (this.provider === 'browserbase') {
        session = await createBrowserbaseSession({ proxy: options.proxy });
      } else {
        session = await createLocalSession({ proxy: options.proxy });
      }
      
      // Get session ID
      const sessionId = this.getSessionId(session);
      
      // Store session with metadata
      this.sessions.set(sessionId, {
        session,
        domain: options.domain,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        isActive: true,
        itemCount: 0
      });
      
      log.normal(`Created ${this.provider} session ${sessionId}`);
      return session;
    } catch (error) {
      log.error(`Failed to create session`, { error });
      throw error;
    }
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
      
      log.normal(`Destroyed session ${sessionId}`);
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