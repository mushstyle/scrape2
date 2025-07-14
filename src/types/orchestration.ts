export interface SessionStats {
  sessionId: string;
  domain?: string;
  itemCount: number;
  lastUsed: Date;
  isActive: boolean;
}

export interface ItemStats {
  total: number;
  pending: number;
  completed: number;
  failed: number;
  invalid: number;
}