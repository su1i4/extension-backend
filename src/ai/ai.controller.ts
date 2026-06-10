import { Body, Controller, Post } from '@nestjs/common';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  // полный анализ одной закупки (с веб-поиском цен)
  @Post('analyze')
  async analyze(@Body('text') text: string) {
    return this.aiService.analyze(text);
  }

  // быстрая оценка списка закупок (без веб-поиска)
  @Post('analyze-list')
  async analyzeList(@Body('items') items: any[]) {
    return this.aiService.analyzeList(items || []);
  }
}