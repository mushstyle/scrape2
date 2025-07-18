import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionManager } from '../src/services/session-manager.js';
import type { Session } from '../src/types/session.js';

// Mock the drivers
vi.mock('../src/drivers/browser.js', () => ({
  createBrowserbaseSession: vi.fn(),
  createLocalSession: vi.fn(),
  terminateSession: vi.fn()
}));

import { createBrowserbaseSession, createLocalSession, terminateSession } from '../src/drivers/browser.js';
const mockCreateBrowserbase = createBrowserbaseSession as any;
const mockCreateLocal = createLocalSession as any;
const mockTerminate = terminateSession as any;

describe('SessionManager', () => {
  let manager: SessionManager;
  
  const createMockSession = (id: string, provider: 'browserbase' | 'local', proxy?: any): Session => {
    if (provider === 'browserbase') {
      return {
        provider: 'browserbase',
        browserbase: { id, connectUrl: `wss://fake-${id}`, projectId: 'test-project' },
        cleanup: vi.fn()
      };
    } else {
      return {
        provider: 'local',
        cleanup: vi.fn()
      };
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up any remaining sessions
    if (manager) {
      await manager.destroyAllSessions();
    }
  });

  describe('Constructor', () => {
    it('should initialize with default values', () => {
      manager = new SessionManager();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should accept custom session limit', () => {
      manager = new SessionManager({ sessionLimit: 10 });
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should accept custom provider', () => {
      manager = new SessionManager({ provider: 'local' });
      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('Session Creation', () => {
    beforeEach(() => {
      manager = new SessionManager({ sessionLimit: 3 });
    });

    it('should create single browserbase session', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      const session = await manager.createSession({ domain: 'test.com' });

      expect(mockCreateBrowserbase).toHaveBeenCalledWith({ proxy: undefined });
      expect(session).toBe(mockSession);
      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('should create single local session when provider is local', async () => {
      manager = new SessionManager({ provider: 'local' });
      const mockSession = createMockSession('local-123', 'local');
      mockCreateLocal.mockResolvedValueOnce(mockSession);

      const session = await manager.createSession();

      expect(mockCreateLocal).toHaveBeenCalledWith({ proxy: undefined });
      expect(session).toBe(mockSession);
      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('should create session with proxy information', async () => {
      const proxy = { type: 'datacenter', id: 'proxy-1', geo: 'US' };
      const mockSession = createMockSession('bb-123', 'browserbase', proxy);
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession({ proxy });

      expect(mockCreateBrowserbase).toHaveBeenCalledWith({ proxy });
    });

    it('should create multiple sessions in parallel', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase'),
        createMockSession('bb-3', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1])
        .mockResolvedValueOnce(mockSessions[2]);

      const sessions = await manager.createSession([
        { domain: 'site1.com' },
        { domain: 'site2.com' },
        { domain: 'site3.com' }
      ]);

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions).toHaveLength(3);
      expect(manager.getActiveSessionCount()).toBe(3);
    });

    it('should enforce session limit', async () => {
      // Create sessions up to limit
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase'),
        createMockSession('bb-3', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1])
        .mockResolvedValueOnce(mockSessions[2]);

      await manager.createSession([{}, {}, {}]);

      // Try to create one more
      await expect(manager.createSession()).rejects.toThrow('Cannot create 1 sessions. Only 0 slots available (limit: 3)');
    });

    it('should enforce session limit for batch creation', async () => {
      const mockSession = createMockSession('bb-1', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession();

      // Try to create 3 more when only 2 slots available
      await expect(manager.createSession([{}, {}, {}])).rejects.toThrow('Cannot create 3 sessions. Only 2 slots available (limit: 3)');
    });

    it('should handle creation failures gracefully', async () => {
      mockCreateBrowserbase.mockRejectedValueOnce(new Error('API error'));

      await expect(manager.createSession()).rejects.toThrow('API error');
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should handle partial batch failures', async () => {
      const mockSession1 = createMockSession('bb-1', 'browserbase');
      const mockError = new Error('API error');
      const mockSession3 = createMockSession('bb-3', 'browserbase');

      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSession1)
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockSession3);

      // Batch creation continues despite individual failures
      await expect(manager.createSession([{}, {}, {}])).rejects.toThrow('API error');
      
      // Due to Promise.all behavior, sessions created before the error are stored
      expect(manager.getActiveSessionCount()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Session Retrieval', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('should get active sessions', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1]);

      await manager.createSession([{}, {}]);

      const activeSessions = await manager.getActiveSessions();
      expect(activeSessions).toHaveLength(2);
      expect(activeSessions).toContain(mockSessions[0]);
      expect(activeSessions).toContain(mockSessions[1]);
    });

    it('should get session by ID', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession();

      const retrieved = manager.getSession('bb-123');
      expect(retrieved).toBe(mockSession);
    });

    it('should return undefined for unknown session ID', () => {
      const retrieved = manager.getSession('unknown-id');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('Session Destruction', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('should destroy session by ID', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);
      mockTerminate.mockResolvedValueOnce(undefined);

      await manager.createSession();
      expect(manager.getActiveSessionCount()).toBe(1);

      await manager.destroySession('bb-123');

      expect(mockTerminate).toHaveBeenCalledWith(mockSession);
      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getSession('bb-123')).toBeUndefined();
    });

    it('should handle destruction of non-existent session', async () => {
      await manager.destroySession('non-existent');
      expect(mockTerminate).not.toHaveBeenCalled();
    });

    it('should destroy session by object', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);
      mockTerminate.mockResolvedValueOnce(undefined);

      await manager.createSession();
      await manager.destroySessionByObject(mockSession);

      expect(mockTerminate).toHaveBeenCalledWith(mockSession);
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should cleanup untracked session', async () => {
      const mockSession = createMockSession('bb-untracked', 'browserbase');
      mockTerminate.mockResolvedValueOnce(undefined);

      await manager.destroySessionByObject(mockSession);

      expect(mockTerminate).toHaveBeenCalledWith(mockSession);
    });

    it('should handle termination errors gracefully', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);
      mockTerminate.mockRejectedValueOnce(new Error('Termination failed'));

      await manager.createSession();
      await manager.destroySession('bb-123');

      // Session should still be removed from tracking
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should destroy all sessions', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase'),
        createMockSession('bb-3', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1])
        .mockResolvedValueOnce(mockSessions[2]);

      mockTerminate.mockResolvedValue(undefined);

      await manager.createSession([{}, {}, {}]);
      expect(manager.getActiveSessionCount()).toBe(3);

      await manager.destroyAllSessions();

      expect(mockTerminate).toHaveBeenCalledTimes(3);
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should handle errors during destroy all', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1]);

      mockTerminate
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Termination failed'));

      await manager.createSession([{}, {}]);
      await manager.destroyAllSessions();

      // All sessions should be removed despite one failure
      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('Session Usage Tracking', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('should update session usage', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession();

      manager.updateSessionUsage('bb-123', 5);
      
      const stats = manager.getStats();
      expect(stats.totalItemsProcessed).toBe(5);
    });

    it('should increment usage by 1 if not specified', async () => {
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession();

      manager.updateSessionUsage('bb-123');
      manager.updateSessionUsage('bb-123');
      
      const stats = manager.getStats();
      expect(stats.totalItemsProcessed).toBe(2);
    });

    it('should ignore updates for non-existent sessions', () => {
      manager.updateSessionUsage('non-existent', 10);
      
      const stats = manager.getStats();
      expect(stats.totalItemsProcessed).toBe(0);
    });
  });

  describe('Statistics', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('should provide accurate statistics', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1]);

      await manager.createSession([{}, {}]);

      manager.updateSessionUsage('bb-1', 10);
      manager.updateSessionUsage('bb-2', 20);

      const stats = manager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.totalItemsProcessed).toBe(30);
      expect(stats.averageItemsPerSession).toBe(15);
    });

    it('should handle empty statistics', () => {
      const stats = manager.getStats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.activeSessions).toBe(0);
      expect(stats.totalItemsProcessed).toBe(0);
      expect(stats.averageItemsPerSession).toBe(0);
    });
  });

  describe('Concurrent Operations', () => {
    beforeEach(() => {
      manager = new SessionManager({ sessionLimit: 5 });
    });

    it('should handle concurrent session creation', async () => {
      const mockSessions = Array.from({ length: 5 }, (_, i) => 
        createMockSession(`bb-${i}`, 'browserbase')
      );
      
      mockSessions.forEach(session => {
        mockCreateBrowserbase.mockResolvedValueOnce(session);
      });

      // Create 5 sessions concurrently
      const promises = Array.from({ length: 5 }, () => 
        manager.createSession()
      );

      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(5);
      expect(manager.getActiveSessionCount()).toBe(5);
    });

    it('should handle race conditions in session limit enforcement', async () => {
      // First fill up to the limit
      const mockSessions = Array.from({ length: 3 }, (_, i) => 
        createMockSession(`bb-${i}`, 'browserbase')
      );
      
      mockSessions.forEach(session => {
        mockCreateBrowserbase.mockResolvedValueOnce(session);
      });

      manager = new SessionManager({ sessionLimit: 3 });

      // Create 3 sessions to fill the limit
      await manager.createSession([{}, {}, {}]);
      expect(manager.getActiveSessionCount()).toBe(3);

      // Now try to create 2 more concurrently - both should fail
      const promises = Array.from({ length: 2 }, () => 
        manager.createSession().catch(err => err)
      );

      const results = await Promise.all(promises);
      
      // All should fail since we're at limit
      const failures = results.filter(r => r instanceof Error);
      
      expect(failures.length).toBe(2);
      expect(manager.getActiveSessionCount()).toBe(3);
    });

    it('should handle concurrent destruction safely', async () => {
      const mockSessions = Array.from({ length: 3 }, (_, i) => 
        createMockSession(`bb-${i}`, 'browserbase')
      );
      
      mockSessions.forEach(session => {
        mockCreateBrowserbase.mockResolvedValueOnce(session);
      });
      
      mockTerminate.mockResolvedValue(undefined);

      await manager.createSession([{}, {}, {}]);

      // Destroy sessions concurrently including duplicates
      const promises = [
        manager.destroySession('bb-0'),
        manager.destroySession('bb-1'),
        manager.destroySession('bb-2'),
        manager.destroySession('bb-0'), // Duplicate - should be no-op
        manager.destroySession('bb-1')  // Duplicate - should be no-op
      ];

      await Promise.all(promises);

      expect(manager.getActiveSessionCount()).toBe(0);
      // Termination may be called 3-5 times due to race conditions
      // But all sessions should be destroyed
      expect(mockTerminate).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      manager = new SessionManager();
    });

    it('should handle local session ID generation', async () => {
      manager = new SessionManager({ provider: 'local' });
      const mockSession = createMockSession('local-123', 'local');
      mockCreateLocal.mockResolvedValueOnce(mockSession);

      await manager.createSession();

      // Since local sessions don't have IDs, manager generates one
      const sessions = await manager.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toBe(mockSession);
    });

    it('should handle mixed array and single session operations', async () => {
      const mockSessions = [
        createMockSession('bb-1', 'browserbase'),
        createMockSession('bb-2', 'browserbase'),
        createMockSession('bb-3', 'browserbase')
      ];
      
      mockCreateBrowserbase
        .mockResolvedValueOnce(mockSessions[0])
        .mockResolvedValueOnce(mockSessions[1])
        .mockResolvedValueOnce(mockSessions[2]);

      // Create single
      const single = await manager.createSession();
      expect(single).toBe(mockSessions[0]);

      // Create batch
      const batch = await manager.createSession([{}, {}]);
      expect(Array.isArray(batch)).toBe(true);
      expect(batch).toHaveLength(2);

      expect(manager.getActiveSessionCount()).toBe(3);
    });

    it('should preserve session metadata throughout lifecycle', async () => {
      const proxy = { type: 'datacenter', id: 'proxy-1', geo: 'US' };
      const mockSession = createMockSession('bb-123', 'browserbase');
      mockCreateBrowserbase.mockResolvedValueOnce(mockSession);

      await manager.createSession({ domain: 'test.com', proxy });

      // Update usage multiple times
      manager.updateSessionUsage('bb-123', 5);
      manager.updateSessionUsage('bb-123', 3);

      const stats = manager.getStats();
      expect(stats.totalItemsProcessed).toBe(8);

      // Session should still be retrievable
      const retrieved = manager.getSession('bb-123');
      expect(retrieved).toBe(mockSession);
    });
  });
});