import { describe, expect, it } from 'vitest';
import {
  DocxParserAdapter,
  DocumentParserFactory,
  PdfParserAdapter,
  TxtParserAdapter,
} from './DocumentParserFactory';

describe('DocumentParserFactory', () => {
  const factory = new DocumentParserFactory(
    new PdfParserAdapter(),
    new DocxParserAdapter(),
    new TxtParserAdapter()
  );

  it('resuelve parser para PDF, DOCX y TXT', () => {
    expect(factory.getParser('application/pdf', 'doc.pdf')).toBeInstanceOf(PdfParserAdapter);
    expect(
      factory.getParser(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc.docx'
      )
    ).toBeInstanceOf(DocxParserAdapter);
    expect(factory.getParser('text/plain', 'readme.txt')).toBeInstanceOf(TxtParserAdapter);
  });

  it('resuelve parser por extensión cuando el MIME es genérico', () => {
    expect(factory.getParser('application/octet-stream', 'archivo.pdf')).toBeInstanceOf(PdfParserAdapter);
    expect(factory.getParser('application/octet-stream', 'archivo.docx')).toBeInstanceOf(DocxParserAdapter);
    expect(factory.getParser('application/octet-stream', 'archivo.txt')).toBeInstanceOf(TxtParserAdapter);
  });

  it('lanza error para formatos no soportados', () => {
    expect(() => factory.getParser('image/png', 'foto.png')).toThrow('Tipo de archivo no soportado');
  });

  it('TxtParserAdapter extrae UTF-8 del buffer', async () => {
    const parser = new TxtParserAdapter();
    const text = await parser.extract(Buffer.from('Contenido RAG de prueba', 'utf-8'), 'test.txt');
    expect(text).toBe('Contenido RAG de prueba');
  });
});
