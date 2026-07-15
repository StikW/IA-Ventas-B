import 'reflect-metadata';
import { container } from 'tsyringe';
import { hasPinecone, hasS3 } from '../config/env';
import { UserRepositoryDynamo } from '../../../modules/identity/infrastructure/persistence/UserRepositoryDynamo';
import { RefreshTokenRepositoryDynamo } from '../../../modules/identity/infrastructure/persistence/RefreshTokenRepositoryDynamo';
import { BusinessRepositoryDynamo } from '../../../modules/tenant/infrastructure/persistence/BusinessRepositoryDynamo';
import { ConfigRepositoryDynamo } from '../../../modules/tenant/infrastructure/persistence/ConfigRepositoryDynamo';
import { ApiKeyRepositoryDynamo } from '../../../modules/tenant/infrastructure/persistence/ApiKeyRepositoryDynamo';
import { DocumentRepositoryDynamo } from '../../../modules/knowledge/infrastructure/persistence/DocumentRepositoryDynamo';
import { OrderRepositoryDynamo } from '../../../modules/commerce/infrastructure/persistence/OrderRepositoryDynamo';
import { WooCommerceConfigRepositoryDynamo } from '../../../modules/woocommerce/infrastructure/persistence/WooCommerceConfigRepositoryDynamo';
import { WooCommerceRestAdapter } from '../../../modules/woocommerce/infrastructure/WooCommerceRestAdapter';
import { BuilderBotCloudAdapter } from '../../../modules/builderbot/infrastructure/BuilderBotCloudAdapter';
import { BuilderBotConfigRepositoryDynamo } from '../../../modules/builderbot/infrastructure/persistence/BuilderBotConfigRepositoryDynamo';
import { BuilderBotWebhookParser } from '../../../modules/builderbot/application/services/BuilderBotWebhookParser';
import { ChatSessionRepositoryDynamo } from '../../../modules/sales-agent/infrastructure/persistence/ChatSessionRepositoryDynamo';
import { OpenAIChatAdapter } from '../../../modules/sales-agent/infrastructure/ai/OpenAIChatAdapter';
import { SalesAgentService } from '../../../modules/sales-agent/application/services/SalesAgentService';
import {
  ConnectBuilderBotPhoneUseCase,
  GetBuilderBotConfigUseCase,
  GetBuilderBotQrImageUseCase,
  GetBuilderBotQrUseCase,
  LinkBuilderBotBotUseCase,
  ProvisionBuilderBotForTenantUseCase,
  ProvisionWhatsAppUseCase,
  RefreshBuilderBotStatusUseCase,
  SyncBuilderBotWebhookUseCase,
} from '../../../modules/builderbot/application/use-cases/BuilderBotUseCases';
import { SalesAgentToolsHandler } from '../../../modules/sales-agent/application/services/SalesAgentToolsHandler';
import { OrderNotificationService } from '../../../modules/commerce/application/services/OrderNotificationService';
import { CreateOrderUseCase, UpdateOrderStatusUseCase } from '../../../modules/commerce/application/use-cases/OrderUseCases';
import { PlatformTenantCleanupService } from '../../../modules/tenant/infrastructure/persistence/PlatformTenantCleanupService';
import { TenantDeletionService } from '../../../modules/tenant/application/services/TenantDeletionService';
import { LocalStorageService } from '../../../modules/knowledge/infrastructure/storage/LocalStorageService';
import { S3StorageService } from '../../../modules/knowledge/infrastructure/storage/S3StorageService';
import { LocalVectorStore } from '../../../modules/knowledge/infrastructure/vector/LocalVectorStore';
import { PineconeVectorStore } from '../../../modules/knowledge/infrastructure/vector/PineconeVectorStore';
import { OpenAIEmbeddingAdapter } from '../../../modules/knowledge/infrastructure/ai/OpenAIEmbeddingAdapter';
import {
  DocxParserAdapter,
  DocumentParserFactory,
  PdfParserAdapter,
  TxtParserAdapter,
} from '../../../modules/knowledge/infrastructure/parsers/DocumentParserFactory';
import { DocumentProcessorService } from '../../../modules/knowledge/application/services/DocumentProcessorService';
import { RagSearchService } from '../../../modules/knowledge/application/services/RagSearchService';
import { AuditService } from '../audit/AuditService';
import { JwtService } from '../security/JwtService';
import { PasswordHasher } from '../security/PasswordHasher';

export function registerDependencies(): void {
  container.registerSingleton('IUserRepository', UserRepositoryDynamo);
  container.registerSingleton('IRefreshTokenRepository', RefreshTokenRepositoryDynamo);
  container.registerSingleton('IBusinessRepository', BusinessRepositoryDynamo);
  container.registerSingleton('IConfigRepository', ConfigRepositoryDynamo);
  container.registerSingleton('IApiKeyRepository', ApiKeyRepositoryDynamo);
  container.registerSingleton('IDocumentRepository', DocumentRepositoryDynamo);
  container.registerSingleton('IOrderRepository', OrderRepositoryDynamo);
  container.registerSingleton('IWooCommerceConfigRepository', WooCommerceConfigRepositoryDynamo);
  container.registerSingleton('IWooCommerceService', WooCommerceRestAdapter);

  container.registerSingleton('IBuilderBotCloudService', BuilderBotCloudAdapter);
  container.registerSingleton('IBuilderBotConfigRepository', BuilderBotConfigRepositoryDynamo);
  container.registerSingleton(BuilderBotWebhookParser, BuilderBotWebhookParser);
  container.registerSingleton('IChatSessionRepository', ChatSessionRepositoryDynamo);
  container.registerSingleton(OpenAIChatAdapter, OpenAIChatAdapter);
  container.registerSingleton(SalesAgentToolsHandler, SalesAgentToolsHandler);
  container.registerSingleton(SalesAgentService, SalesAgentService);
  container.registerSingleton(OrderNotificationService, OrderNotificationService);
  container.registerSingleton(PlatformTenantCleanupService, PlatformTenantCleanupService);
  container.registerSingleton(TenantDeletionService, TenantDeletionService);

  if (hasS3) {
    container.registerSingleton('IStorageService', S3StorageService);
  } else {
    container.registerSingleton('IStorageService', LocalStorageService);
  }

  container.registerSingleton('IEmbeddingProvider', OpenAIEmbeddingAdapter);

  if (hasPinecone) {
    container.registerSingleton('IVectorStore', PineconeVectorStore);
  } else {
    container.registerSingleton('IVectorStore', LocalVectorStore);
  }

  container.registerSingleton(JwtService, JwtService);
  container.registerSingleton(PasswordHasher, PasswordHasher);
  container.registerSingleton(AuditService, AuditService);
  container.registerSingleton(PdfParserAdapter, PdfParserAdapter);
  container.registerSingleton(DocxParserAdapter, DocxParserAdapter);
  container.registerSingleton(TxtParserAdapter, TxtParserAdapter);
  container.registerSingleton(DocumentParserFactory, DocumentParserFactory);
  container.registerSingleton(DocumentProcessorService, DocumentProcessorService);
  container.registerSingleton(RagSearchService, RagSearchService);

  container.registerSingleton(GetBuilderBotConfigUseCase, GetBuilderBotConfigUseCase);
  container.registerSingleton(GetBuilderBotQrUseCase, GetBuilderBotQrUseCase);
  container.registerSingleton(GetBuilderBotQrImageUseCase, GetBuilderBotQrImageUseCase);
  container.registerSingleton(RefreshBuilderBotStatusUseCase, RefreshBuilderBotStatusUseCase);
  container.registerSingleton(ProvisionBuilderBotForTenantUseCase, ProvisionBuilderBotForTenantUseCase);
  container.registerSingleton(ProvisionWhatsAppUseCase, ProvisionWhatsAppUseCase);
  container.registerSingleton(ConnectBuilderBotPhoneUseCase, ConnectBuilderBotPhoneUseCase);
  container.registerSingleton(LinkBuilderBotBotUseCase, LinkBuilderBotBotUseCase);
  container.registerSingleton(SyncBuilderBotWebhookUseCase, SyncBuilderBotWebhookUseCase);
  container.registerSingleton(CreateOrderUseCase, CreateOrderUseCase);
  container.registerSingleton(UpdateOrderStatusUseCase, UpdateOrderStatusUseCase);
}
