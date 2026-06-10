import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TendersService } from './tenders.service';
import { ScraperService } from './scraper.service';

@Controller('tenders')
export class TendersController {
  constructor(
    private readonly tendersService: TendersService,
    private readonly scraperService: ScraperService,
  ) {}

  // плагин шлёт сюда после AI-анализа
  @Post()
  async save(@Body() body: any) {
    return this.tendersService.saveAnalysis(body);
  }

  // список с фильтрами
  @Get()
  async list(
    @Query('verdict') verdict?: string,
    @Query('minSum') minSum?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tendersService.list({
      verdict,
      minSum: minSum ? parseInt(minSum, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // статистика
  @Get('stats')
  async stats() {
    return this.tendersService.stats();
  }

  @Post('scrape')
  async scrape(@Query('pages') pages?: string) {
    const maxPages = pages ? parseInt(pages, 10) : 50;
    // НЕ await — пускаем в фон, чтобы curl не таймаутил
    this.scraperService.scrapeAll(maxPages).catch((e) => console.error(e));
    return { started: true, message: 'Сбор запущен в фоне, смотри логи Nest' };
  }
  
  @Get('new-count')
  async newCount() {
    return { count: await this.tendersService.newCount() };
  }

  // список новых
  @Get('new')
  async listNew(@Query('limit') limit?: string) {
    return this.tendersService.listNew(limit ? parseInt(limit, 10) : undefined);
  }

  // пометить прочитанными (пустое тело = все)
  @Post('mark-viewed')
  async markViewed(@Body() body: { ids?: number[] }) {
    return this.tendersService.markViewed(body?.ids);
  }
}
