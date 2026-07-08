import { inject, injectable } from 'tsyringe';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { IDocumentParser } from '../../domain/ports/KnowledgePorts';

@injectable()
export class PdfParserAdapter implements IDocumentParser {
  supports(mimeType: string, filename: string): boolean {
    return mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
  }

  async extract(buffer: Buffer, _filename: string): Promise<string> {
    const result = await pdf(buffer);
    return result.text;
  }
}

@injectable()
export class DocxParserAdapter implements IDocumentParser {
  supports(mimeType: string, filename: string): boolean {
    return (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.toLowerCase().endsWith('.docx')
    );
  }

  async extract(buffer: Buffer, _filename: string): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
}

@injectable()
export class TxtParserAdapter implements IDocumentParser {
  supports(mimeType: string, filename: string): boolean {
    return mimeType === 'text/plain' || filename.toLowerCase().endsWith('.txt');
  }

  async extract(buffer: Buffer, _filename: string): Promise<string> {
    return buffer.toString('utf-8');
  }
}

@injectable()
export class DocumentParserFactory {
  constructor(
    @inject(PdfParserAdapter) private readonly pdfParser: PdfParserAdapter,
    @inject(DocxParserAdapter) private readonly docxParser: DocxParserAdapter,
    @inject(TxtParserAdapter) private readonly txtParser: TxtParserAdapter
  ) {}

  getParser(mimeType: string, filename: string): IDocumentParser {
    const parsers = [this.pdfParser, this.docxParser, this.txtParser];
    const parser = parsers.find((p) => p.supports(mimeType, filename));
    if (!parser) {
      throw new Error(`Tipo de archivo no soportado: ${mimeType || filename}`);
    }
    return parser;
  }
}
