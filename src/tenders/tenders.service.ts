import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tender } from './tender.entity';

@Injectable()
export class TendersService {
  constructor(
    @InjectRepository(Tender)
    private readonly repo: Repository<Tender>,
  ) {}

  // "1 072 080" → 1072080
  private parseSum(s?: string): number | undefined {
    if (!s) return undefined;
    const digits = String(s).replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : undefined;
  }

  // upsert: если номер уже есть — обновляем результат анализа
  async saveAnalysis(input: {
    number: string;
    name: string;
    organization?: string;
    method?: string;
    plannedSum?: string;
    deadline?: string;
    url?: string;
    analysis: any;
  }): Promise<Tender> {
    if (!input.number) throw new Error('номер закупки обязателен');

    const existing = await this.repo.findOne({
      where: { number: input.number },
    });
    const data: Partial<Tender> = {
      number: input.number,
      name: input.name,
      organization: input.organization,
      method: input.method,
      plannedSum: this.parseSum(input.plannedSum),
      plannedSumRaw: input.plannedSum,
      deadline: input.deadline,
      url: input.url,
      analysis: input.analysis,
      verdict: input.analysis?.verdict,
      verdictReason: input.analysis?.verdictReason,
    };

    if (existing) {
      await this.repo.update(existing.id, data);
      return (await this.repo.findOne({ where: { id: existing.id } }))!;
    }
    return this.repo.save(this.repo.create(data));
  }

  // сохранение без AI-анализа — для скрапера (данные только со списка)
  async saveBasic(input: {
    number: string;
    name: string;
    organization?: string;
    method?: string;
    plannedSum?: string;
    deadline?: string;
    url?: string;
  }): Promise<Tender> {
    if (!input.number) throw new Error('номер закупки обязателен');

    const existing = await this.repo.findOne({
      where: { number: input.number },
    });
    const data: Partial<Tender> = {
      number: input.number,
      name: input.name,
      organization: input.organization,
      method: input.method,
      plannedSum: this.parseSum(input.plannedSum),
      plannedSumRaw: input.plannedSum,
      deadline: input.deadline,
      url: input.url,
    };

    if (existing) {
      // обновляем только базовые поля, не трогая analysis/verdict (если они уже были)
      await this.repo.update(existing.id, data);
      return (await this.repo.findOne({ where: { id: existing.id } }))!;
    }
    return this.repo.save(this.repo.create(data));
  }

  // список с фильтрами
  async list(params: {
    verdict?: string;
    minSum?: number;
    limit?: number;
  }): Promise<Tender[]> {
    const qb = this.repo.createQueryBuilder('t').orderBy('t.createdAt', 'DESC');
    if (params.verdict) qb.andWhere('t.verdict = :v', { v: params.verdict });
    if (params.minSum) qb.andWhere('t.plannedSum >= :s', { s: params.minSum });
    qb.limit(params.limit ?? 50);
    return qb.getMany();
  }

  // статистика для дашборда
  async stats(): Promise<any> {
    const totalRow = await this.repo
      .createQueryBuilder('t')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(t.plannedSum), 0)', 'avgSum')
      .addSelect('COALESCE(SUM(t.plannedSum), 0)', 'totalSum')
      .getRawOne();

    const byVerdictRaw = await this.repo
      .createQueryBuilder('t')
      .select('t.verdict', 'verdict')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.verdict')
      .getRawMany();

    const byVerdict: Record<string, number> = {};
    byVerdictRaw.forEach((r) => {
      byVerdict[r.verdict || 'без оценки'] = parseInt(r.count, 10);
    });

    const topOrgsRaw = await this.repo
      .createQueryBuilder('t')
      .select('t.organization', 'organization')
      .addSelect('COUNT(*)', 'count')
      .where('t.organization IS NOT NULL')
      .groupBy('t.organization')
      .orderBy('count', 'DESC')
      .limit(5)
      .getRawMany();

    return {
      total: parseInt(totalRow.total, 10),
      avgSum: Math.round(parseFloat(totalRow.avgsum || totalRow.avgSum || 0)),
      totalSum: parseInt(totalRow.totalsum || totalRow.totalSum || 0, 10),
      byVerdict,
      topOrgs: topOrgsRaw.map((r) => ({
        organization: r.organization,
        count: parseInt(r.count, 10),
      })),
    };
  }

  // кол-во новых (для баджа на колокольчике)
  async newCount(): Promise<number> {
    return this.repo.count({ where: { isViewed: false } });
  }

  // список новых
  async listNew(limit = 100): Promise<Tender[]> {
    return this.repo.find({
      where: { isViewed: false },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // пометить прочитанными: без ids — все новые; с ids — только указанные
  async markViewed(ids?: number[]): Promise<{ updated: number }> {
    const qb = this.repo
      .createQueryBuilder()
      .update(Tender)
      .set({ isViewed: true })
      .where('isViewed = false');
    if (ids?.length) qb.andWhere('id IN (:...ids)', { ids });
    const res = await qb.execute();
    return { updated: res.affected ?? 0 };
  }
}
