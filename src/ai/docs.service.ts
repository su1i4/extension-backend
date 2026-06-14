import { Injectable, Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import WordExtractor from 'word-extractor';

// извлечение текста из прикреплённых документов закупки (PDF / DOC / DOCX / XLS)
@Injectable()
export class DocsService {
  private readonly logger = new Logger(DocsService.name);
  private readonly wordExtractor = new WordExtractor();

  // лимиты под free-tier: большие файлы и длинные тексты не тащим
  private readonly MAX_BYTES = 8 * 1024 * 1024; // 8 МБ на файл
  private readonly MAX_CHARS = 12_000; // обрезка текста одного файла

  // главный метод: текст из буфера по расширению имени
  async extractText(buf: Buffer, filename: string): Promise<string> {
    if (!buf?.length) return '';
    if (buf.length > this.MAX_BYTES) {
      this.logger.warn(
        `Пропускаю ${filename}: ${Math.round(buf.length / 1e6)} МБ > лимита`,
      );
      return '';
    }

    const ext = (filename.split('.').pop() || '').toLowerCase();
    try {
      let text = '';
      if (ext === 'pdf') text = await this.fromPdf(buf, filename);
      else if (ext === 'docx') text = await this.fromDocx(buf);
      else if (ext === 'doc') text = await this.fromDoc(buf);
      else if (ext === 'xlsx' || ext === 'xls') text = this.fromXls(buf);
      else return ''; // неизвестный формат — игнор

      return this.clean(text).slice(0, this.MAX_CHARS);
    } catch (e) {
      this.logger.warn(`Не извлёк ${filename}: ${(e as Error).message}`);
      return '';
    }
  }

  // удобный хелпер: собрать единый текст из пачки файлов
  async extractMany(
    files: { buffer: Buffer; filename: string }[],
  ): Promise<string> {
    const parts: string[] = [];
    for (const f of files) {
      const t = await this.extractText(f.buffer, f.filename);
      if (t) parts.push(`--- Документ: ${f.filename} ---\n${t}`);
    }
    return parts.join('\n\n');
  }

  private async fromPdf(buf: Buffer, filename: string): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      const text = (result.text || '').trim();
      // мало текста = скан/картинка. OCR на free-tier не тянем.
      if (text.length < 40) {
        this.logger.warn(
          `${filename}: похоже скан/картинка, текста нет (без OCR)`,
        );
      }
      return text;
    } finally {
      await parser.destroy(); // освобождаем pdfjs-ресурсы — важно для RAM
    }
  }

  private async fromDocx(buf: Buffer): Promise<string> {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value || '';
  }

  private async fromDoc(buf: Buffer): Promise<string> {
    const doc = await this.wordExtractor.extract(buf);
    return doc.getBody() || '';
  }

  private fromXls(buf: Buffer): string {
    const wb = XLSX.read(buf, { type: 'buffer' });
    return wb.SheetNames.map(
      (n) => `[${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]),
    ).join('\n\n');
  }

  private clean(s: string): string {
    return s
      .replace(/\u0000/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}