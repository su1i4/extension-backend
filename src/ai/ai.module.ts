import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { DocsService } from './docs.service';

@Module({
  controllers: [AiController],
  providers: [AiService, DocsService],
  exports: [AiService],
})
export class AiModule {}