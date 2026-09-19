import { Request, Response, NextFunction } from 'express';
import { container } from 'tsyringe';
import {
  DeleteDocumentUseCase,
  DownloadDocumentUseCase,
  ListDocumentsUseCase,
  RefreshCatalogDocumentUseCase,
  ReprocessDocumentUseCase,
  UploadDocumentUseCase,
} from '../../application/use-cases/DocumentUseCases';
import { KnowledgeSearchUseCase } from '../../application/use-cases/KnowledgeSearchUseCase';

export class DocumentController {
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'Archivo requerido' } });
        return;
      }
      const useCase = container.resolve(UploadDocumentUseCase);
      const result = await useCase.execute({ actor: req.user!, file: req.file });
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ListDocumentsUseCase);
      const result = await useCase.execute({
        actor: req.user!,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: req.query.cursor as string | undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(DeleteDocumentUseCase);
      await useCase.execute({ actor: req.user!, id: String(req.params.id) });
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }

  async reprocess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(ReprocessDocumentUseCase);
      const result = await useCase.execute({ actor: req.user!, id: String(req.params.id) });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }

  async refreshCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(RefreshCatalogDocumentUseCase);
      const result = await useCase.execute({ actor: req.user! });
      res.status(201).json({ data: result.document, catalog: result.catalog });
    } catch (err) {
      next(err);
    }
  }

  async download(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(DownloadDocumentUseCase);
      const result = await useCase.execute({ actor: req.user!, id: String(req.params.id) });
      const safeName = result.filename.replace(/[\r\n"]/g, '');
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Length', String(result.buffer.length));
      res.send(result.buffer);
    } catch (err) {
      next(err);
    }
  }
}

export class KnowledgeController {
  async search(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const useCase = container.resolve(KnowledgeSearchUseCase);
      const result = await useCase.execute({
        tenantId: req.apiKeyContext!.tenantId,
        query: req.body.query,
        topK: req.body.topK,
        minScore: req.body.minScore,
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const documentController = new DocumentController();
export const knowledgeController = new KnowledgeController();
