import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PriceSourcesService } from './source.service';

type UploadedFileLike = { buffer: Buffer; originalname: string };

@Controller('price-sources')
export class PriceSourcesController {
  constructor(private readonly svc: PriceSourcesService) {}

  // список всех источников
  @Get()
  list() {
    return this.svc.list();
  }

  // готовый текстовый блок «ИСТОЧНИКИ ЦЕН» — для клиентского анализа в расширении
  @Get('context')
  context() {
    return this.svc.buildPriceContext();
  }

  // добавить ссылку на сайт
  @Post('url')
  addUrl(@Body() body: { url: string; title?: string }) {
    return this.svc.addUrl(body?.url, body?.title);
  }

  // загрузить Excel/прайс (multipart, поле "file")
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  addExcel(@UploadedFile() file: UploadedFileLike) {
    return this.svc.addExcel(file.buffer, file.originalname);
  }

  // включить/выключить источник
  @Post(':id/toggle')
  toggle(@Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.svc.toggle(parseInt(id, 10), !!body?.enabled);
  }

  // удалить источник
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(parseInt(id, 10));
  }
}