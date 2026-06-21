import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceSource } from './source.entity';
import { PriceSourcesService } from './source.service';
import { PriceSourcesController } from './source.controller';
import { AiModule } from 'src/ai/ai.module'; // ← модуль, который экспортит DocsService

@Module({
  imports: [TypeOrmModule.forFeature([PriceSource]), AiModule],
  controllers: [PriceSourcesController],
  providers: [PriceSourcesService],
  exports: [PriceSourcesService], // нужен в TendersModule для скрапера
})
export class PriceSourcesModule {}