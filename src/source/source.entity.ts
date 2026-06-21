import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('price_sources')
export class PriceSource {
  @PrimaryGeneratedColumn()
  id!: number;

  // 'url' — ссылка на сайт-источник; 'excel' — загруженная брошюра/прайс
  @Index()
  @Column({ type: 'varchar', length: 16 })
  type!: 'url' | 'excel';

  // отображаемое имя (для url — можно описание, для excel — имя файла)
  @Column({ type: 'text' })
  title!: string;

  // только для type='url'
  @Column({ type: 'text', nullable: true })
  url?: string;

  // только для type='excel'
  @Column({ type: 'varchar', length: 255, nullable: true })
  filename?: string;

  // извлечённый текст прайса (из Excel) — подмешивается в промпт AI
  @Column({ type: 'text', nullable: true })
  content?: string;

  // выключенные источники не участвуют в поиске цен
  @Index()
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}