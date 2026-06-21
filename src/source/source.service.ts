import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PriceSource } from './source.entity';
import { DocsService } from 'src/ai/docs.service';

@Injectable()
export class PriceSourcesService {
  constructor(
    @InjectRepository(PriceSource)
    private readonly repo: Repository<PriceSource>,
    private readonly docsService: DocsService,
  ) {}

  list(): Promise<PriceSource[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  // добавить ссылку на сайт-источник
  addUrl(url: string, title?: string): Promise<PriceSource> {
    const clean = (url || '').trim();
    if (!/^https?:\/\//i.test(clean)) {
      throw new Error('url должен начинаться с http:// или https://');
    }
    return this.repo.save(
      this.repo.create({
        type: 'url',
        url: clean,
        title: (title || '').trim() || clean,
        enabled: true,
      }),
    );
  }

  // загрузить Excel/прайс: извлекаем текст через DocsService и кладём в content
  async addExcel(buffer: Buffer, filename: string): Promise<PriceSource> {
    const content = await this.docsService.extractText(buffer, filename);
    return this.repo.save(
      this.repo.create({
        type: 'excel',
        filename,
        title: filename,
        content,
        enabled: true,
      }),
    );
  }

  async toggle(id: number, enabled: boolean): Promise<PriceSource | null> {
    await this.repo.update(id, { enabled });
    return this.repo.findOne({ where: { id } });
  }

  async remove(id: number): Promise<{ deleted: boolean }> {
    const res = await this.repo.delete(id);
    return { deleted: (res.affected ?? 0) > 0 };
  }

  // собрать блок «ИСТОЧНИКИ ЦЕН» для подмешивания в промпт AI.
  // Порядок приоритета: [1] Excel-прайсы → [2] сайты-ссылки → [3] общая оценка.
  // maxExcelChars ограничивает объём текста из Excel, чтобы не раздуть промпт.
  async buildPriceContext(maxExcelChars = 12000): Promise<string> {
    const sources = await this.repo.find({
      where: { enabled: true },
      order: { createdAt: 'ASC' },
    });
    const excels = sources.filter((s) => s.type === 'excel' && s.content);
    const urls = sources.filter((s) => s.type === 'url' && s.url);

    if (!excels.length && !urls.length) return '';

    let ctx = `\n\nИСТОЧНИКИ ЦЕН — используй СТРОГО в этом порядке приоритета:\n`;

    if (excels.length) {
      ctx += `\n[1] ПРАЙСЫ ИЗ EXCEL (искать цену здесь В ПЕРВУЮ ОЧЕРЕДЬ):\n`;
      let budget = maxExcelChars;
      for (const e of excels) {
        if (budget <= 0) break;
        const chunk = (e.content || '').slice(0, budget);
        budget -= chunk.length;
        ctx += `\n--- Файл «${e.filename}» ---\n${chunk}\n`;
      }
    }

    if (urls.length) {
      ctx += `\n[2] САЙТЫ-ИСТОЧНИКИ (если в Excel цены нет — взять отсюда):\n`;
      for (const u of urls) {
        ctx += `- ${u.title}: ${u.url}\n`;
      }
    }

    ctx += `\n[3] Если цены нет ни в Excel, ни на сайтах выше — дай общую рыночную оценку и пометь источник цены как "оценка".\n`;
    return ctx;
  }
}