import { injectable } from 'tsyringe';
import { BuilderBotWebhookEvent, BuilderBotWebhookEventType } from '../../domain/BuilderBotWebhook.types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readText(message: Record<string, unknown>): string | undefined {
  const text = asRecord(message.text);
  if (text?.body) return String(text.body);
  if (message.body) return String(message.body);
  if (typeof message.text === 'string') return message.text;
  return undefined;
}

function readMediaUrl(message: Record<string, unknown>): string | undefined {
  const image = asRecord(message.image);
  if (image?.url) return String(image.url);
  if (image?.link) return String(image.link);
  if (message.mediaUrl) return String(message.mediaUrl);
  if (message.media_url) return String(message.media_url);
  const media = asRecord(message.media);
  if (media?.url) return String(media.url);
  return undefined;
}

@injectable()
export class BuilderBotWebhookParser {
  parse(payload: unknown): BuilderBotWebhookEvent[] {
    const root = asRecord(payload);
    if (!root) return [];

    const events: BuilderBotWebhookEvent[] = [];

    for (const entry of asArray(root.entry)) {
      const entryRecord = asRecord(entry);
      if (!entryRecord) continue;

      for (const change of asArray(entryRecord.changes)) {
        const changeRecord = asRecord(change);
        const value = asRecord(changeRecord?.value);
        if (!value) continue;

        events.push(...this.parseMessages(value));
        events.push(...this.parseStatuses(value));
        events.push(...this.parseSession(value));
      }
    }

    if (events.length === 0) {
      events.push(...this.parseRootPayload(root));
    }

    return events.length > 0 ? events : [{ type: 'unknown' }];
  }

  private parseMessages(value: Record<string, unknown>): BuilderBotWebhookEvent[] {
    return asArray(value.messages)
      .map((item) => asRecord(item))
      .filter((message): message is Record<string, unknown> => !!message)
      .map((message) => ({
        type: 'message.incoming' as BuilderBotWebhookEventType,
        from: message.from ? String(message.from) : undefined,
        messageId: message.id ? String(message.id) : undefined,
        messageType: message.type ? String(message.type) : undefined,
        text: readText(message),
        mediaUrl: readMediaUrl(message),
        caption: message.caption ? String(message.caption) : undefined,
        timestamp: message.timestamp ? String(message.timestamp) : undefined,
      }));
  }

  private parseStatuses(value: Record<string, unknown>): BuilderBotWebhookEvent[] {
    return asArray(value.statuses)
      .map((item) => asRecord(item))
      .filter((status): status is Record<string, unknown> => !!status)
      .map((status) => ({
        type: 'message.status' as BuilderBotWebhookEventType,
        messageId: status.id ? String(status.id) : undefined,
        from: status.recipient_id ? String(status.recipient_id) : undefined,
        status: status.status ? String(status.status) : undefined,
        timestamp: status.timestamp ? String(status.timestamp) : undefined,
      }));
  }

  private parseSession(value: Record<string, unknown>): BuilderBotWebhookEvent[] {
    const sessionStatus = value.sessionStatus ?? value.session_status ?? value.status;
    if (!sessionStatus) return [];

    return [
      {
        type: 'session.update',
        sessionStatus: String(sessionStatus),
        deviceId: value.deviceId ? String(value.deviceId) : value.device ? String(value.device) : undefined,
      },
    ];
  }

  private parseRootPayload(root: Record<string, unknown>): BuilderBotWebhookEvent[] {
    const events: BuilderBotWebhookEvent[] = [];

    events.push(...this.parseMessages(root));
    events.push(...this.parseStatuses(root));
    events.push(...this.parseSession(root));

    const data = asRecord(root.data);
    if (data) {
      events.push(...this.parseMessages(data));
      events.push(...this.parseStatuses(data));
      events.push(...this.parseSession(data));
    }

    const eventName = String(root.event ?? root.type ?? '').toLowerCase();
    if (events.length === 0 && (eventName.includes('message') || root.from || root.phone)) {
      const message = asRecord(root.message) ?? root;
      events.push({
        type: eventName.includes('status') ? 'message.status' : 'message.incoming',
        from: root.from ? String(root.from) : root.phone ? String(root.phone) : undefined,
        messageId: message.id ? String(message.id) : root.messageId ? String(root.messageId) : undefined,
        messageType: message.type ? String(message.type) : undefined,
        text: readText(message) ?? (root.text ? String(root.text) : undefined),
        mediaUrl: readMediaUrl(message),
        caption: message.caption ? String(message.caption) : undefined,
        status: root.status ? String(root.status) : undefined,
        deviceId: root.deviceId ? String(root.deviceId) : root.device ? String(root.device) : undefined,
        sessionStatus: root.sessionStatus ? String(root.sessionStatus) : undefined,
        timestamp: root.timestamp ? String(root.timestamp) : undefined,
      });
    }

    return events;
  }
}
