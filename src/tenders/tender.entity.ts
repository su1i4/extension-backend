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

  @Column({ type: 'varchar', length: 64, nullable: true })
  deadline?: string;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  verdict?: string;

  @Column({ type: 'text', nullable: true })
  verdictReason?: string;

  // полный JSON-ответ AI (лоты, риски, выгодность)
  @Column({ type: 'jsonb', nullable: true })
  analysis?: any;

  @Column({ type: 'text', nullable: true })
  url?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Index()
  @Column({ type: 'boolean', default: false })
  isViewed!: boolean;
}
