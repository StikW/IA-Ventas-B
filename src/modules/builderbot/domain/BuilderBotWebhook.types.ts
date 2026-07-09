export type BuilderBotWebhookEventType =
  | 'message.incoming'
  | 'message.status'
  | 'session.update'
  | 'unknown';

export interface BuilderBotWebhookEvent {
  type: BuilderBotWebhookEventType;
  from?: string;
  messageId?: string;
  messageType?: string;
  text?: string;
  mediaUrl?: string;
  caption?: string;
  status?: string;
  deviceId?: string;
  sessionStatus?: string;
  timestamp?: string;
}

export interface BuilderBotWebhookResult {
  received: true;
  tenantId: string;
  deviceId: string;
  eventsProcessed: number;
  events: Array<{ type: BuilderBotWebhookEventType; messageId?: string; from?: string }>;
  incomingMessages: Array<{
    from: string;
    text: string;
    messageId?: string;
    messageType?: string;
  }>;
  incomingImages: Array<{
    from: string;
    messageId?: string;
    messageType?: string;
    mediaUrl?: string;
    caption?: string;
  }>;
}
