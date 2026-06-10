import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as puppeteer from 'puppeteer';
import { TendersService } from './tenders.service';

const LIST_URL = 'https://zakupki.okmot.kg/popp/view/order/list.xhtml';

@Injectable()
export class ScraperService implements OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private isRunning = false;
  private browser: puppeteer.Browser | null = null;

  // прогресс для UI
  private progress = { collected: 0, pages: 0, finishedAt: 0, startedAt: 0 };

  constructor(private readonly tendersService: TendersService) {}

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

  async scrapeAll(maxPages = 50): Promise<{ collected: number; pages: number }> {
    if (this.isRunning) {
      this.logger.warn('Сбор уже идёт, новый запуск отклонён');
      return { collected: 0, pages: 0 };
    }

    this.isRunning = true;
    this.progress = { collected: 0, pages: 0, finishedAt: 0, startedAt: Date.now() };
    let collected = 0;
    let pages = 0;

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--single-process',
          '--no-zygote',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      });
      const page = await this.browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      );

      this.logger.log(`Открываю ${LIST_URL}`);
      await page.goto(LIST_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
      await page.waitForSelector('[id$="table_data"] > tr', { timeout: 30_000 });

      while (pages < maxPages) {
        pages++;
        await page.waitForSelector('[id$="table_data"] > tr', { timeout: 30_000 });

        const items = await page.evaluate(() => {
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
              ).trim().replace(/\s+/g, ' '),
              method: cellValue(cells[5]),
              plannedSum: cellValue(cells[6]),
              publishDate: cellValue(cells[7]),
              deadline: cellValue(cells[8]),
            };
            const link = row.querySelector('a[href*="view.xhtml"]') as HTMLAnchorElement | null;
            if (link) it.url = link.href;
            if (it.number) out.push(it);
          });
          return out;
        });

        this.logger.log(`Страница ${pages}: найдено ${items.length} закупок`);

        for (const item of items) {
          try {
            await this.tendersService.saveBasic(item);
            collected++;
            this.progress.collected = collected;
          } catch (e) {
            this.logger.warn(`Не сохранил ${item.number}: ${(e as Error).message}`);
          }
        }
        this.progress.pages = pages;

        const hasNext = await page.evaluate(() => {
          const btn = document.querySelector('.ui-paginator-next');
          if (!btn) return false;
          return !btn.classList.contains('ui-state-disabled');
        });

        if (!hasNext) {
          this.logger.log('Пагинация закончилась');
          break;
        }

        await page.evaluate(() => {
          const btn = document.querySelector('.ui-paginator-next') as HTMLElement;
          btn?.click();
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (e) {
      this.logger.error(`Ошибка сбора: ${(e as Error).message}`);
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      this.progress.finishedAt = Date.now();
      this.isRunning = false;
    }

    const took = Math.round((Date.now() - this.progress.startedAt) / 1000);
    this.logger.log(`✓ Готово: ${collected} сохранено, ${pages} страниц, ${took}с`);
    return { collected, pages };
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleCron() {
    this.logger.log('Cron: автоматический сбор тендеров');
    await this.scrapeAll();
  }
}