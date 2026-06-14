import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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

  // "19.06.2026 10:00" → Date
  private parseDeadline(s?: string): Date | undefined {
    if (!s) return undefined;
    const m = String(s)
      .trim()
      .match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) return undefined;
    const [, dd, mm, yyyy, hh = '00', min = '00'] = m;
    const d = new Date(+yyyy, +mm - 1, +dd, +hh, +min);
    return isNaN(d.getTime()) ? undefined : d;
  }

  // дата публикации — тот же формат dd.mm.yyyy[ hh:mm], что и дедлайн
  private parsePublishedAt(s?: string): Date | undefined {
    return this.parseDeadline(s);
  }

  // безопасно вытащить число из чего угодно ("125 000 сом" → 125000)
  private num(v: any): number | undefined {
    if (v === null || v === undefined) return undefined;
    const n =
      typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? undefined : n;
  }

  // рейтинг по марже (по ТЗ): F убыток · D <5 · C 5–10 · B 10–20 · A 20–30 · A+ >30
  private ratingFromMargin(margin?: number): string | undefined {
    if (margin === undefined || margin === null) return undefined;
    if (margin < 0) return 'F';
    if (margin < 5) return 'D';
    if (margin < 10) return 'C';
    if (margin < 20) return 'B';
    if (margin <= 30) return 'A';
    return 'A+';
  }

  // суммирует выбранные поля по всем лотам (null/отсутствие — пропускаем)
  private sumLots(analysis: any, pick: (lot: any) => any[]): number | undefined {
    const lots = Array.isArray(analysis?.lots) ? analysis.lots : [];
    if (!lots.length) return undefined;
    let sum = 0;
    let any = false;
    for (const lot of lots) {
      for (const v of pick(lot)) {
        const n = this.num(v);
        if (n !== undefined) {
          sum += n;
          any = true;
        }
      }
    }
    return any ? sum : undefined;
  }

  // экономика: себестоимость + юнит-экономика (валовая/чистая прибыль, маржа, ROI, рейтинг)
  private deriveEconomics(plannedSum?: number, analysis?: any) {
    const a = analysis || {};

    // полная себестоимость: верхний cost → сумма lot.cost → сумма всех компонентов лотов
    const cost =
      this.num(a.cost ?? a.costPrice) ??
      this.sumLots(a, (l) => [l?.cost]) ??
      this.sumLots(a, (l) => [
        l?.costBreakdown?.goods,
        l?.costBreakdown?.delivery,
        l?.costBreakdown?.taxes,
        l?.costBreakdown?.fees,
        l?.costBreakdown?.reserve,
      ]);

    // прямые затраты (товар + доставка) — база для валовой прибыли
    const directCost = this.sumLots(a, (l) => [
      l?.costBreakdown?.goods,
      l?.costBreakdown?.delivery,
    ]);

    let grossProfit: number | undefined;
    let profit = this.num(a.profit); // чистая
    let margin = this.num(a.margin);
    let roi = this.num(a.roi);

    if (plannedSum !== undefined) {
      if (directCost !== undefined) grossProfit = plannedSum - directCost;
      if (profit === undefined && cost !== undefined) {
        profit = plannedSum - cost;
      }
    }
    if (margin === undefined && plannedSum && profit !== undefined) {
      margin = (profit / plannedSum) * 100;
    }
    if (roi === undefined && cost && profit !== undefined) {
      roi = (profit / cost) * 100;
    }

    // рейтинг считаем строго по марже кодом — AI ничего не «угадывает»
    const rating = this.ratingFromMargin(margin);
    const round1 = (n?: number) =>
      n !== undefined ? Math.round(n * 10) / 10 : undefined;

    return {
      cost,
      grossProfit,
      profit,
      margin: round1(margin),
      roi: round1(roi),
      rating,
    };
  }

  // upsert: если номер уже есть — обновляем результат анализа
  async saveAnalysis(input: {
    number: string;
    name: string;
    organization?: string;
    method?: string;
    plannedSum?: string;
    deadline?: string;
    publishDate?: string;
    url?: string;
    analysis: any;
  }): Promise<Tender> {
    if (!input.number) throw new Error('номер закупки обязателен');

    const existing = await this.repo.findOne({
      where: { number: input.number },
    });

    const plannedSum = this.parseSum(input.plannedSum);
    const eco = this.deriveEconomics(plannedSum, input.analysis);

    const data: Partial<Tender> = {
      number: input.number,
      name: input.name,
      organization: input.organization,
      method: input.method,
      plannedSum,
      plannedSumRaw: input.plannedSum,
      deadline: input.deadline,
      deadlineAt: this.parseDeadline(input.deadline),
      publishDate: input.publishDate,
      publishedAt: this.parsePublishedAt(input.publishDate),
      url: input.url,
      analysis: input.analysis,
      verdict: input.analysis?.verdict,
      verdictReason: input.analysis?.verdictReason,
      cost: eco.cost,
      profit: eco.profit,
      grossProfit: eco.grossProfit,
      margin: eco.margin,
      roi: eco.roi,
      rating: eco.rating,
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
    publishDate?: string;
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
      deadlineAt: this.parseDeadline(input.deadline),
      publishDate: input.publishDate,
      publishedAt: this.parsePublishedAt(input.publishDate),
      url: input.url,
    };

    if (existing) {
      // обновляем только базовые поля, не трогая analysis/verdict (если они уже были)
      await this.repo.update(existing.id, data);
      return (await this.repo.findOne({ where: { id: existing.id } }))!;
    }
    return this.repo.save(this.repo.create(data));
  }

  // какие из переданных номеров уже есть в базе
  async existingNumbers(numbers: string[]): Promise<Set<string>> {
    if (!numbers.length) return new Set();
    const rows = await this.repo.find({
      where: { number: In(numbers) },
      select: { number: true },
    });
    return new Set(rows.map((r) => r.number));
  }

  // список с фильтрами + пагинация
  async list(params: {
    verdict?: string;
    rating?: string;
    minSum?: number;
    minMargin?: number;
    minProfit?: number;
    analyzed?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    items: Tender[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = params.page && params.page > 0 ? params.page : 1;
    const limit = params.limit && params.limit > 0 ? params.limit : 50;

    const qb = this.repo
      .createQueryBuilder('t')
      .orderBy('t.publishedAt', 'DESC', 'NULLS LAST')
      .addOrderBy('t.id', 'DESC');
    if (params.verdict) qb.andWhere('t.verdict = :v', { v: params.verdict });
    if (params.rating) qb.andWhere('t.rating = :r', { r: params.rating });
    if (params.minSum) qb.andWhere('t.plannedSum >= :s', { s: params.minSum });
    if (params.minMargin !== undefined)
      qb.andWhere('t.margin >= :m', { m: params.minMargin });
    if (params.minProfit !== undefined)
      qb.andWhere('t.profit >= :p', { p: params.minProfit });
    if (params.analyzed) qb.andWhere('t.verdict IS NOT NULL');

    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
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