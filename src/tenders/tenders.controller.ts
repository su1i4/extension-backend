import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TendersService } from './tenders.service';
import { ScraperService } from './scraper.service';
import { DocsService } from 'src/ai/docs.service';

type UploadedFileLike = { buffer: Buffer; originalname: string };

@Controller('tenders')
export class TendersController {
  constructor(
    private readonly tendersService: TendersService,
    private readonly scraperService: ScraperService,
    private readonly docsService: DocsService,
  ) {}

  // временный эндпоинт для проверки извлечения текста из файла
  @Post('test-extract')
  @UseInterceptors(FileInterceptor('file'))
  async testExtract(@UploadedFile() file: UploadedFileLike) {
    const text = await this.docsService.extractText(
      file.buffer,
      file.originalname,
    );
    return {
      filename: file.originalname,
      length: text.length,
      preview: text.slice(0, 500),
    };
  }

  // плагин шлёт сюда после AI-анализа
  @Post()
  async save(@Body() body: any) {
    return this.tendersService.saveAnalysis(body);
  }

  // список с фильтрами + пагинация
  @Get()
  async list(
    @Query('verdict') verdict?: string,
    @Query('rating') rating?: string,
    @Query('minSum') minSum?: string,
    @Query('minMargin') minMargin?: string,
    @Query('minProfit') minProfit?: string,
    @Query('analyzed') analyzed?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tendersService.list({
      verdict,
      rating,
      minSum: minSum ? parseInt(minSum, 10) : undefined,
      minMargin: minMargin ? parseFloat(minMargin) : undefined,
      minProfit: minProfit ? parseInt(minProfit, 10) : undefined,
      analyzed: analyzed === '1' || analyzed === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post('scrape-active')
  async scrapeActive(@Query('pages') pages?: string) {
    const maxPages = pages ? parseInt(pages, 10) : 50;
    this.scraperService
      .scrapeActiveAndAnalyze(maxPages)
      .catch((e) => console.error(e));
    return { started: true };
  }

  @Get('scrape/status')
  scrapeStatus() {
    return this.scraperService.getStatus();
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
