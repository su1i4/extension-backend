import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as puppeteer from 'puppeteer';
import { TendersService } from './tenders.service';
import { AiService } from '../ai/ai.service';
import { DocsService } from '../ai/docs.service';
import { PriceSourcesService } from '../source/source.service';

const LIST_URL = 'https://zakupki.okmot.kg/popp/view/order/list.xhtml';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

@Injectable()
export class ScraperService implements OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private isRunning = false;
  private browser: puppeteer.Browser | null = null;

  // прогресс для UI
  private progress = { collected: 0, pages: 0, finishedAt: 0, startedAt: 0 };

  constructor(
    private readonly tendersService: TendersService,
    private readonly aiService: AiService,
    private readonly docsService: DocsService,
    private readonly priceSourcesService: PriceSourcesService,
  ) {}

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // статус для фронтенда
  getStatus() {
    return {
      running: this.isRunning,
      collected: this.progress.collected,
      pages: this.progress.pages,
      startedAt: this.progress.startedAt,
      finishedAt: this.progress.finishedAt,
    };
  }

  // ============================================================
  // ХЕЛПЕРЫ
  // ============================================================

  // устойчивый переход: domcontentloaded + одна попытка ретрая
  private async safeGoto(page: puppeteer.Page, url: string, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        return;
      } catch (e) {
        if (i === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // дедлайн в бишкекском времени (UTC+6) ещё не наступил?
  private isDeadlineActive(deadline?: string): boolean {
    if (!deadline) return false;
    const m = deadline
      .trim()
      .match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) return false;
    const [, dd, mm, yyyy, hh = '23', min = '59'] = m;
    const deadlineUtcMs =
      Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min) - 6 * 3600 * 1000;
    return deadlineUtcMs > Date.now();
  }

  private buildTextForAI(
    item: any,
    detail: { lots: any[]; requirements: any[] },
  ): string {
    let text = `Закупка №${item.number}\nНаименование: ${item.name}\nОрганизация: ${item.organization}\nМетод закупок: ${item.method}\nПланируемая сумма: ${item.plannedSum}\nСрок подачи: ${item.deadline}\n\n`;
    if (detail.lots?.length) {
      text += `Лоты:\n`;
      detail.lots.forEach((l) => {
        text += `- ${l.number} ${l.name}, сумма ${l.sum}, поставка: ${l.deliveryTerm}, место: ${l.place}\n`;
      });
      text += '\n';
    }
    if (detail.requirements?.length) {
      text += `Квалификационные требования:\n`;
      detail.requirements.forEach((r, i) => {
        text += `${i + 1}. ${r.qualification} — ${r.requirement}\n`;
      });
    }
    return text;
  }

  // запуск браузера с настройками под Render/локалку
  private async launchBrowser(): Promise<puppeteer.Page> {
    const lowMem = !!process.env.RENDER; // на Render выставляется автоматически
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        ...(lowMem ? ['--single-process', '--no-zygote'] : []),
      ],
    });
    const page = await this.browser.newPage();
    await page.setUserAgent(UA);
    return page;
  }

  // извлечь закупки с текущей страницы списка
  private async extractListItems(page: puppeteer.Page): Promise<any[]> {
    return page.evaluate(() => {
      function cellValue(cell: Element) {
        const span = cell.querySelector('span');
        let txt = cell.textContent || '';
        if (span) txt = txt.replace(span.textContent || '', '');
        return txt.trim().replace(/\s+/g, ' ');
      }
      const out: any[] = [];
      document.querySelectorAll('[id$="table_data"] > tr').forEach((row) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 9) return;
        const it: any = {
          number: cellValue(cells[0]),
          organization: cellValue(cells[1]),
          type: cellValue(cells[2]),
          name: (
            row.querySelector('.nameTender')?.textContent || cellValue(cells[3])
          )
            .trim()
            .replace(/\s+/g, ' '),
          method: cellValue(cells[5]),
          plannedSum: cellValue(cells[6]),
          publishDate: cellValue(cells[7]),
          deadline: cellValue(cells[8]),
        };
        const link = row.querySelector(
          'a[href*="view.xhtml"]',
        ) as HTMLAnchorElement | null;
        if (link) it.url = link.href;
        if (it.number) out.push(it);
      });
      return out;
    });
  }

  // раскрыть строки лотов (PrimeFaces toggler) — догружает таблицу «Продукты» с файлами
  private async expandLotRows(page: puppeteer.Page) {
    const sel = '[id$="lotsTable_data"] .ui-row-toggler[aria-expanded="false"]';
    for (let i = 0; i < 50; i++) {
      const toggler = await page.$(sel);
      if (!toggler) break;
      const before = await page
        .$$eval(
          '[id$="lotsTable_data"] tr.ui-expanded-row-content',
          (els) => els.length,
        )
        .catch(() => 0);
      await toggler.click();
      await page
        .waitForFunction(
          (n: number) =>
            document.querySelectorAll(
              '[id$="lotsTable_data"] tr.ui-expanded-row-content',
            ).length > n,
          { timeout: 8000 },
          before,
        )
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // распарсить детальную страницу закупки (лоты + требования)
  private async extractDetail(
    page: puppeteer.Page,
  ): Promise<{ lots: any[]; requirements: any[] }> {
    return page.evaluate(() => {
      const lots: any[] = [];
      document
        .querySelectorAll('[id$="lotsTable_data"] > tr')
        .forEach((row) => {
          const cells = row.querySelectorAll('td');
          const lot: any = {};
          cells.forEach((cell) => {
            const labelSpan = cell.querySelector('span:not(.bold)');
            const boldSpan = cell.querySelector('span.bold');
            if (!labelSpan) return;
            const key = (labelSpan.textContent || '').trim();
            let value = boldSpan
              ? (boldSpan.textContent || '').trim()
              : (cell.textContent || '').replace(key, '').trim();
            value = value.replace(/\s+/g, ' ');
            if (key === '№') lot.number = value;
            else if (key === 'Наименование лота') lot.name = value;
            else if (key === 'Сумма') lot.sum = value;
            else if (key.includes('Адрес')) lot.place = value;
            else if (key.includes('Сроки поставки')) lot.deliveryTerm = value;
          });
          if (lot.number || lot.name) lots.push(lot);
        });

      const requirements: any[] = [];
      document.querySelectorAll('.publicTableData').forEach((table) => {
        const headers = table.querySelector('thead')?.textContent || '';
        if (headers.includes('Квалификация')) {
          table.querySelectorAll('tbody tr').forEach((tr) => {
            const tds = tr.querySelectorAll('td');
            if (tds.length >= 3)
              requirements.push({
                qualification: (tds[1].textContent || '')
                  .trim()
                  .replace(/\s+/g, ' '),
                requirement: (tds[2].textContent || '')
                  .trim()
                  .replace(/\s+/g, ' '),
              });
          });
        }
      });

      return { lots, requirements };
    });
  }

  // берём только файлы из колонки «Детальное описание товара в виде файла»
  private async extractAttachments(
    page: puppeteer.Page,
  ): Promise<{ label: string; filename: string; url: string }[]> {
    return page.evaluate(() => {
      const HEADER = 'Детальное описание товара в виде файла';
      const norm = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const seen = new Set<string>();
      const out: { label: string; filename: string; url: string }[] = [];

      document.querySelectorAll('table').forEach((table) => {
        const headers = Array.from(table.querySelectorAll('thead th'));
        const colIdx = headers.findIndex((th) =>
          norm(th.textContent || '').includes(HEADER),
        );
        if (colIdx === -1) return;

        table.querySelectorAll('tbody > tr').forEach((row) => {
          const cells = row.querySelectorAll(':scope > td');
          const cell = cells[colIdx];
          if (!cell) return;
          cell
            .querySelectorAll('a[href*="/popp/download?key="]')
            .forEach((a) => {
              const href = (a as HTMLAnchorElement).href;
              let key = '';
              try {
                key = new URL(href).searchParams.get('key') || '';
              } catch {
                key = '';
              }
              if (!key || seen.has(href)) return;
              seen.add(href);
              const filename = norm(a.textContent || '');
              out.push({ label: HEADER, filename, url: href });
            });
        });
      });

      return out;
    });
  }

  // скачать файл через сессию страницы (cookies переиспользуются)
  private async downloadFile(
    page: puppeteer.Page,
    url: string,
    maxBytes = 10 * 1024 * 1024,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const result = await page.evaluate(
        async (fileUrl: string, limit: number) => {
          const res = await fetch(fileUrl, { credentials: 'include' });
          if (!res.ok) return { error: `status ${res.status}` };
          const contentType = res.headers.get('content-type') || '';
          const len = parseInt(res.headers.get('content-length') || '0', 10);
          if (len && len > limit) return { error: `too big ${len}` };
          const buf = await res.arrayBuffer();
          if (buf.byteLength > limit)
            return { error: `too big ${buf.byteLength}` };
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(
              ...(bytes.subarray(i, i + chunk) as unknown as number[]),
            );
          }
          return { base64: btoa(binary), contentType };
        },
        url,
        maxBytes,
      );

      if (!result || (result as any).error) {
        if (result && (result as any).error)
          this.logger.warn(`Скачивание ${url}: ${(result as any).error}`);
        return null;
      }
      const r = result as { base64: string; contentType: string };
      return {
        buffer: Buffer.from(r.base64, 'base64'),
        contentType: r.contentType,
      };
    } catch (e) {
      this.logger.warn(`Скачивание не удалось ${url}: ${(e as Error).message}`);
      return null;
    }
  }

  // имя без расширения → добавим по content-type (для DocsService важно расширение)
  private ensureExt(name: string, contentType: string): string {
    const base = name && name.trim() ? name.trim() : 'file';
    if (/\.(pdf|docx?|xlsx?)$/i.test(base)) return base;
    const map: Record<string, string> = {
      'application/pdf': 'pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'docx',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        'xlsx',
      'application/vnd.ms-excel': 'xls',
    };
    const ct = contentType.split(';')[0].trim().toLowerCase();
    const ext = map[ct];
    return ext ? `${base}.${ext}` : base;
  }

  // скачать файлы «детальное описание товара» и вытащить из них текст
  private async collectDocsText(page: puppeteer.Page): Promise<string> {
    await this.expandLotRows(page);
    const attachments = await this.extractAttachments(page);
    if (!attachments.length) return '';

    const files: { buffer: Buffer; filename: string }[] = [];
    for (const att of attachments) {
      const dl = await this.downloadFile(page, att.url);
      if (!dl) continue;
      // HTML вместо файла = редирект/страница регистрации, не документ
      if (dl.contentType.toLowerCase().includes('text/html')) {
        this.logger.warn(
          `Пропуск ${att.filename || att.url}: вернулся HTML (нужна авторизация?)`,
        );
        continue;
      }
      const filename = this.ensureExt(
        att.filename || att.label,
        dl.contentType,
      );
      files.push({ buffer: dl.buffer, filename });
    }
    if (!files.length) return '';

    const text = await this.docsService.extractMany(files);
    return text ? `\n\nДОКУМЕНТЫ ЗАКУПКИ:\n${text}\n` : '';
  }

  private async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async debugDocs(viewUrl: string) {
    const page = await this.launchBrowser();
    try {
      await this.safeGoto(page, viewUrl);
      await page.waitForSelector('.label', { timeout: 15_000 }).catch(() => {});
      await this.expandLotRows(page);
      const attachments = await this.extractAttachments(page);
      const text = await this.collectDocsText(page);
      return {
        attachments,
        filesText: {
          length: text.length,
          preview: text.slice(0, 1500),
        },
      };
    } finally {
      await this.closeBrowser();
    }
  }

  // ============================================================
  // АКТИВНЫЕ + АНАЛИЗ — собрать активные, отфильтровать новые,
  // прогнать через AI, сохранить (всплывут в уведомлениях)
  // ============================================================
  async scrapeActiveAndAnalyze(
    maxPages = 50,
  ): Promise<{ collected: number; pages: number }> {
    if (this.isRunning) {
      this.logger.warn('Сбор уже идёт, новый запуск отклонён');
      return { collected: 0, pages: 0 };
    }

    this.isRunning = true;
    this.progress = {
      collected: 0,
      pages: 0,
      finishedAt: 0,
      startedAt: Date.now(),
    };
    let analyzed = 0;
    let pages = 0;

    try {
      const page = await this.launchBrowser();

      await this.safeGoto(page, LIST_URL);
      await page.waitForSelector('[id$="table_data"] > tr', {
        timeout: 30_000,
      });

      // --- 1) собираем активные со всех страниц ---
      const active: any[] = [];
      while (pages < maxPages) {
        pages++;
        await page.waitForSelector('[id$="table_data"] > tr', {
          timeout: 30_000,
        });

        const items = await this.extractListItems(page);
        items.forEach((it) => {
          if (this.isDeadlineActive(it.deadline)) active.push(it);
        });
        this.progress.pages = pages;

        const hasNext = await page.evaluate(() => {
          const btn = document.querySelector('.ui-paginator-next');
          return !!btn && !btn.classList.contains('ui-state-disabled');
        });
        if (!hasNext) break;

        await page.evaluate(() => {
          (
            document.querySelector('.ui-paginator-next') as HTMLElement
          )?.click();
        });
        await new Promise((r) => setTimeout(r, 1500));
      }

      // --- 2) только новые (которых нет в базе) ---
      const existing = await this.tendersService.existingNumbers(
        active.map((i) => i.number),
      );
      const fresh = active.filter((i) => !existing.has(i.number));
      this.logger.log(`Активных: ${active.length}, новых: ${fresh.length}`);

      // блок «ИСТОЧНИКИ ЦЕН» собираем один раз на весь прогон
      const priceContext = await this.priceSourcesService.buildPriceContext();

      // --- 3) детальная страница (в отдельной вкладке) → AI → сохранить ---
      for (const item of fresh) {
        try {
          let analysis: any = {};
          if (item.url) {
            const dp = await this.browser!.newPage();
            try {
              await dp.setUserAgent(UA);
              await this.safeGoto(dp, item.url);
              await dp
                .waitForSelector('[id$="lotsTable_data"], .label', {
                  timeout: 15_000,
                })
                .catch(() => {}); // нет лотов — парсим что есть
              const detail = await this.extractDetail(dp);
              const docsText = await this.collectDocsText(dp);
              const text =
                this.buildTextForAI(item, detail) + docsText + priceContext;
              const r: any = await this.aiService.analyze(text);
              analysis = (r?.result ?? r)?.analysis ?? {};
            } finally {
              await dp.close(); // вкладку всегда закрываем
            }
          }

          await this.tendersService.saveAnalysis({
            number: item.number,
            name: item.name,
            organization: item.organization,
            method: item.method,
            plannedSum: item.plannedSum,
            deadline: item.deadline,
            publishDate: item.publishDate,
            url: item.url,
            analysis,
          });
          analyzed++;
          this.progress.collected = analyzed;
        } catch (e) {
          this.logger.warn(
            `Не обработал ${item.number}: ${(e as Error).message}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`Ошибка сбора: ${(e as Error).message}`);
    } finally {
      await this.closeBrowser();
      this.progress.finishedAt = Date.now();
      this.isRunning = false;
    }

    this.logger.log(`✓ Проанализировано новых: ${analyzed} (страниц ${pages})`);
    return { collected: analyzed, pages };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    this.logger.log('Cron: автоматический сбор активных тендеров с анализом');
    await this.scrapeActiveAndAnalyze();
  }

  // раз в час удаляем тендеры с истёкшим сроком подачи
  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup() {
    const { deleted } = await this.tendersService.deleteExpired();
    if (deleted) this.logger.log(`Удалено просроченных тендеров: ${deleted}`);
  }
}