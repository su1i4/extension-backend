import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { TendersModule } from './tenders/tenders.module';
import { Tender } from './tenders/tender.entity';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5433,
      username: 'postgres',
      password: 'root',
      database: 'lessons',
      synchronize: true,
      entities: [Tender],
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), 
    AiModule,
    TendersModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}