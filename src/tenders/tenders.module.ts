import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tender } from './tender.entity';
import { TendersController } from './tenders.controller';
import { TendersService } from './tenders.service';
import { ScraperService } from './scraper.service';
import { AiModule } from 'src/ai/ai.module';

@Module({
  imports: [TypeOrmModule.forFeature([Tender]), AiModule],
  controllers: [TendersController],
  providers: [TendersService, ScraperService],
})
export class TendersModule {}