import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('tenders')
export class Tender {
  @PrimaryGeneratedColumn()
  id!: number;

  // номер закупки с сайта (уникальный)
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  number!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  organization?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  method?: string;

  // сумма как число (для сортировки) и как строка (как было на сайте)
  @Column({ type: 'bigint', nullable: true })
  plannedSum?: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  plannedSumRaw?: string;

  // срок подачи: сырая строка + распарсенная дата (для сортировки/фильтров)
  @Column({ type: 'varchar', length: 64, nullable: true })
  deadline?: string;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  deadlineAt?: Date;

  // дата публикации на портале: сырая строка + распарсенная дата (для сортировки)
  @Column({ type: 'varchar', length: 64, nullable: true })
  publishDate?: string;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt?: Date;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  verdict?: string;

  @Column({ type: 'text', nullable: true })
  verdictReason?: string;

  // --- экономика (для дашборда и фильтров ТЗ) ---
  @Column({ type: 'bigint', nullable: true })
  cost?: number; // себестоимость

  @Column({ type: 'bigint', nullable: true })
  profit?: number; // чистая прибыль = сумма − полная себестоимость

  @Column({ type: 'bigint', nullable: true })
  grossProfit?: number; // валовая прибыль = сумма − (товар + доставка)

  @Index()
  @Column({ type: 'double precision', nullable: true })
  margin?: number; // маржа %

  @Column({ type: 'double precision', nullable: true })
  roi?: number; // ROI %

  @Index()
  @Column({ type: 'varchar', length: 4, nullable: true })
  rating?: string; // A+ / A / B / C / D / F

  // полный JSON-ответ AI (лоты, риски, выгодность)
  @Column({ type: 'jsonb', nullable: true })
  analysis?: any;

  @Index()
  @Column({ type: 'varchar', length: 32, nullable: true })
  category?: string;

  @Column({ type: 'text', nullable: true })
  url?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  isViewed!: boolean;
}