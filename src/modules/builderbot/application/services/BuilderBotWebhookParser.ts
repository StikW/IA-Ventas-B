import { injectable } from 'tsyringe';
import { BuilderBotWebhookEvent, BuilderBotWebhookEventType } from '../../domain/BuilderBotWebhook.types';

import { isBuilderBotTemplateLiteral } from '../../infrastructure/builderBotPhone';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readText(message: Record<string, unknown>): string | undefined {
  const interactive = readInteractiveReply(message);
  if (interactive.text) return interactive.text;

  const text = asRecord(message.text);
  if (text?.body) return String(text.body);
  if (message.body) return String(message.body);
  if (typeof message.text === 'string') return message.text;
  return undefined;
}

function readInteractiveReply(message: Record<string, unknown>): { text?: string; buttonId?: string } {
  const interactive = asRecord(message.interactive);
  if (interactive) {
    const buttonReply = asRecord(interactive.button_reply);
    if (buttonReply?.title || buttonReply?.id) {
      return {
        text: String(buttonReply.title ?? buttonReply.id),
        buttonId: buttonReply.id ? String(buttonReply.id) : undefined,
      };
    }
    const listReply = asRecord(interactive.list_reply);
    if (listReply?.title || listReply?.id) {
      return {
        text: String(listReply.title ?? listReply.id),
        buttonId: listReply.id ? String(listReply.id) : undefined,
      };
    }
  }

  const button = asRecord(message.button);
  if (button?.text || button?.payload) {
    return {
      text: String(button.text ?? button.payload),
      buttonId: button.payload ? String(button.payload) : undefined,
    };
  }

  const selected = message.selectedButtonId ?? message.selectedId ?? message.buttonId;
  if (selected) {
    return { text: String(selected), buttonId: String(selected) };
  }

  return {};
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

function readFrom(root: Record<string, unknown>): string | undefined {
  if (root.from) return String(root.from);
  if (root.phone) return String(root.phone);
  const contact = asRecord(root.contact);
  if (contact?.phone) return String(contact.phone);
  const user = asRecord(root.user);
  if (user?.phone) return String(user.phone);
  return undefined;
}

function readIncomingText(root: Record<string, unknown>): string | undefined {
  const interactive = readInteractiveReply(root);
  if (interactive.text && !isBuilderBotTemplateLiteral(interactive.text)) return interactive.text;

  const direct = readText(root);
  if (direct && !isBuilderBotTemplateLiteral(direct)) return direct;
  if (typeof root.text === 'string' && !isBuilderBotTemplateLiteral(root.text)) return root.text;
  if (typeof root.capture === 'string' && !isBuilderBotTemplateLiteral(root.capture)) return root.capture;
  if (typeof root.body === 'string' && !isBuilderBotTemplateLiteral(root.body)) return root.body;
  if (typeof root.message === 'string' && !isBuilderBotTemplateLiteral(root.message)) return root.message;
  const message = asRecord(root.message);
  if (message) {
    const nested = readText(message);
    if (nested && !isBuilderBotTemplateLiteral(nested)) return nested;
  }
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

    const ctx = asRecord(root.ctx);
    if (ctx) {
      const from = ctx.from ? String(ctx.from) : undefined;
      const text = ctx.body ? String(ctx.body) : undefined;
      if (from && text && !isBuilderBotTemplateLiteral(from) && !isBuilderBotTemplateLiteral(text)) {
        events.push({
          type: 'message.incoming',
          from,
          text,
          messageType: 'text',
        });
      }
    }

    const eventName = String(root.event ?? root.type ?? '').toLowerCase();
    if (events.length === 0 && (eventName.includes('message') || root.from || root.phone)) {
      const from = readFrom(root);
      const text = readIncomingText(root);
      if (from && text && !isBuilderBotTemplateLiteral(from) && !isBuilderBotTemplateLiteral(text)) {
        const message = asRecord(root.message) ?? root;
        events.push({
          type: eventName.includes('status') ? 'message.status' : 'message.incoming',
          from,
          messageId: message.id ? String(message.id) : root.messageId ? String(root.messageId) : undefined,
          messageType: message.type ? String(message.type) : 'text',
          text,
          mediaUrl: readMediaUrl(message),
          caption: message.caption ? String(message.caption) : undefined,
          status: root.status ? String(root.status) : undefined,
          deviceId: root.deviceId ? String(root.deviceId) : root.device ? String(root.device) : undefined,
          sessionStatus: root.sessionStatus ? String(root.sessionStatus) : undefined,
          timestamp: root.timestamp ? String(root.timestamp) : undefined,
        });
      }
    }

    const nested = asRecord(root.payload) ?? asRecord(root.response);
    if (nested && events.length === 0) {
      const from = readFrom(nested);
      const text = readIncomingText(nested);
      if (from && text && !isBuilderBotTemplateLiteral(from) && !isBuilderBotTemplateLiteral(text)) {
        events.push({
          type: 'message.incoming',
          from,
          text,
          messageType: 'text',
        });
      }
    }

    return events;
  }
}
