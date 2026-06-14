import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as puppeteer from 'puppeteer';
import { TendersService } from './tenders.service';
import { AiService } from '../ai/ai.service'; // ← путь под свой проект

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

  private async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // ============================================================
  // ОБЫЧНЫЙ СБОР (без AI) — для базы/статистики
  // ============================================================
  async scrapeAll(
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
    let collected = 0;
    let pages = 0;

    try {
      const page = await this.launchBrowser();

      this.logger.log(`Открываю ${LIST_URL}`);
      await this.safeGoto(page, LIST_URL);
      await page.waitForSelector('[id$="table_data"] > tr', {
        timeout: 30_000,
      });

      while (pages < maxPages) {
        pages++;
        await page.waitForSelector('[id$="table_data"] > tr', {
          timeout: 30_000,
        });

        const items = await this.extractListItems(page);
        this.logger.log(`Страница ${pages}: найдено ${items.length} закупок`);

        for (const item of items) {
          try {
            await this.tendersService.saveBasic(item);
            collected++;
            this.progress.collected = collected;
          } catch (e) {
            this.logger.warn(
              `Не сохранил ${item.number}: ${(e as Error).message}`,
            );
          }
        }
        this.progress.pages = pages;

        const hasNext = await page.evaluate(() => {
          const btn = document.querySelector('.ui-paginator-next');
          return !!btn && !btn.classList.contains('ui-state-disabled');
        });
        if (!hasNext) {
          this.logger.log('Пагинация закончилась');
          break;
        }

        await page.evaluate(() => {
          (
            document.querySelector('.ui-paginator-next') as HTMLElement
          )?.click();
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      this.logger.error(`Ошибка сбора: ${(e as Error).message}`);
    } finally {
      await this.closeBrowser();
      this.progress.finishedAt = Date.now();
      this.isRunning = false;
    }

    const took = Math.round((Date.now() - this.progress.startedAt) / 1000);
    this.logger.log(
      `✓ Готово: ${collected} сохранено, ${pages} страниц, ${took}с`,
    );
    return { collected, pages };
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
              const text = this.buildTextForAI(item, detail);
              const r: any = await this.aiService.analyze(text); // ← метод твоего AI-сервиса
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

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleCron() {
    this.logger.log('Cron: автоматический сбор тендеров');
    await this.scrapeAll();
  }
}