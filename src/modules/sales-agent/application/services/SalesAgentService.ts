import { inject, injectable } from 'tsyringe';
import { hasBuilderBot, hasOpenAI } from '../../../../shared/infrastructure/config/env';
import { AuditService } from '../../../../shared/infrastructure/audit/AuditService';
import { logger } from '../../../../shared/infrastructure/logger/logger';
import { IBuilderBotCloudService } from '../../../builderbot/domain/IBuilderBotCloudService';
import { RagSearchService } from '../../../knowledge/application/services/RagSearchService';
import { IBusinessRepository } from '../../../tenant/domain/repositories/IBusinessRepository';
import { IConfigRepository } from '../../../tenant/domain/repositories/IConfigRepository';
import { IWooCommerceConfigRepository, IWooCommerceService, WooCommerceProduct } from '../../../woocommerce/domain/IWooCommerceService';
import { ChatMessage, IChatSessionRepository } from '../../domain/IChatSessionRepository';
import { OpenAIChatAdapter } from '../../infrastructure/ai/OpenAIChatAdapter';

const AGENT_ACTOR = 'system:sales-agent';

export interface SalesAgentMessageInput {
  tenantId: string;
  deviceId: string;
  customerPhone: string;
  text: string;
  messageId?: string;
}

export interface SalesAgentMessageResult {
  replied: boolean;
  reply?: string;
  reason?: string;
}

@injectable()
export class SalesAgentService {
  constructor(
    @inject('IBusinessRepository') private readonly businessRepo: IBusinessRepository,
    @inject('IConfigRepository') private readonly configRepo: IConfigRepository,
    @inject('IBuilderBotCloudService') private readonly builderBot: IBuilderBotCloudService,
    @inject('IChatSessionRepository') private readonly chatRepo: IChatSessionRepository,
    @inject('IWooCommerceConfigRepository') private readonly wcConfigRepo: IWooCommerceConfigRepository,
    @inject('IWooCommerceService') private readonly wcService: IWooCommerceService,
    @inject(RagSearchService) private readonly ragSearch: RagSearchService,
    @inject(OpenAIChatAdapter) private readonly chat: OpenAIChatAdapter,
    @inject(AuditService) private readonly audit: AuditService
  ) {}

  async handleIncomingMessage(input: SalesAgentMessageInput): Promise<SalesAgentMessageResult> {
    if (!hasOpenAI) {
      return { replied: false, reason: 'OPENAI_NOT_CONFIGURED' };
    }
    if (!hasBuilderBot) {
      return { replied: false, reason: 'BUILDERBOT_NOT_CONFIGURED' };
    }

    const text = input.text.trim();
    if (!text) {
      return { replied: false, reason: 'EMPTY_MESSAGE' };
    }

    const business = await this.businessRepo.findById(input.tenantId);
    const businessName = business?.name ?? 'el negocio';
    const tenantConfig = await this.configRepo.findByTenantId(input.tenantId);

    const [rag, catalogContext, session] = await Promise.all([
      this.ragSearch.search({ tenantId: input.tenantId, query: text, topK: 5, minScore: 0.45 }),
      this.buildCatalogContext(input.tenantId),
      this.chatRepo.find(input.tenantId, input.customerPhone),
    ]);

    const ragContext = rag.results.length
      ? rag.results.map((r: { source: string; content: string }, i: number) => `[${i + 1}] (${r.source}) ${r.content}`).join('\n\n')
      : 'Sin documentos relevantes para esta consulta.';

    const systemPrompt = this.buildSystemPrompt({
      businessName,
      businessProfile: tenantConfig?.business,
      ragContext,
      catalogContext,
    });

    const history = session?.messages ?? [];
    const reply = await this.chat.complete({
      systemPrompt,
      history,
      userMessage: text,
    });

    const now = new Date().toISOString();
    const updatedMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: text, at: now },
      { role: 'assistant', content: reply, at: now },
    ];

    await this.chatRepo.save({
      tenantId: input.tenantId,
      customerPhone: input.customerPhone,
      messages: updatedMessages,
      updatedAt: now,
    });

    await this.builderBot.sendTextMessage({
      deviceId: input.deviceId,
      phone: input.customerPhone,
      message: reply,
    });

    await this.audit.log({
      tenantId: input.tenantId,
      userId: AGENT_ACTOR,
      action: 'BUILDERBOT_MESSAGE_SENT',
      resource: 'whatsapp_message',
      resourceId: input.messageId,
      metadata: {
        customerPhone: input.customerPhone,
        replyPreview: reply.slice(0, 120),
        ragHits: rag.results.length,
      },
    });

    logger.info(
      {
        tenantId: input.tenantId,
        customerPhone: input.customerPhone,
        ragHits: rag.results.length,
      },
      'Agente de ventas respondió por WhatsApp'
    );

    return { replied: true, reply };
  }

  private buildSystemPrompt(input: {
    businessName: string;
    businessProfile?: {
      description?: string;
      address?: string;
      businessHours?: string;
      bankAccountInfo?: string;
    };
    ragContext: string;
    catalogContext: string;
  }): string {
    const profileLines = [
      input.businessProfile?.description ? `Descripción: ${input.businessProfile.description}` : null,
      input.businessProfile?.address ? `Dirección: ${input.businessProfile.address}` : null,
      input.businessProfile?.businessHours ? `Horario: ${input.businessProfile.businessHours}` : null,
      input.businessProfile?.bankAccountInfo ? `Datos de pago: ${input.businessProfile.bankAccountInfo}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    return [
      `Eres el asistente de ventas por WhatsApp de "${input.businessName}".`,
      'Responde siempre en español, de forma amable, clara y concisa (máximo 3 párrafos cortos).',
      'Usa SOLO la información del contexto de documentos y catálogo. No inventes productos, precios ni stock.',
      'Si no tienes información suficiente, dilo con honestidad y ofrece alternativas (ej. pedir más detalle o contactar al negocio).',
      'Si el cliente quiere comprar, pídele que confirme producto, cantidad y datos de contacto.',
      profileLines ? `\nInformación del negocio:\n${profileLines}` : '',
      `\nContexto de documentos (RAG):\n${input.ragContext}`,
      input.catalogContext ? `\nCatálogo WooCommerce:\n${input.catalogContext}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async buildCatalogContext(tenantId: string): Promise<string> {
    try {
      const config = await this.wcConfigRepo.findByTenantId(tenantId);
      if (!config?.connected) return '';

      const products = await this.wcService.listProducts(config, 1);
      if (!products.length) return '';

      return products
        .slice(0, 12)
        .map((p: WooCommerceProduct) => `- ${p.name} | SKU: ${p.sku || 'N/A'} | Precio: ${p.price} | Stock: ${p.stockStatus}`)
        .join('\n');
    } catch {
      return '';
    }
  }
}
