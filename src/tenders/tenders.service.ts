import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Tender } from './tender.entity';

// поля, по которым разрешена сортировка (whitelist — защита от инъекции в orderBy)
const SORTABLE: Record<string, string> = {
  publishedAt: 't.publishedAt', // дата публикации
  deadlineAt: 't.deadlineAt', // срок подачи
  plannedSum: 't.plannedSum', // сумма
  margin: 't.margin', // маржа
  profit: 't.profit', // чистая прибыль
  grossProfit: 't.grossProfit', // валовая прибыль
  roi: 't.roi', // ROI
  cost: 't.cost', // себестоимость
  createdAt: 't.createdAt', // добавлено в базу
};

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
    // время на портале — бишкекское (UTC+6); приводим к корректному UTC,
    // чтобы сравнение с now() не зависело от таймзоны сервера (Render = UTC)
    const ms = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min) - 6 * 3600 * 1000;
    const d = new Date(ms);
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
  private sumLots(
    analysis: any,
    pick: (lot: any) => any[],
  ): number | undefined {
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

    // категория от AI: берём только из списка, иначе «Прочее»
    const ALLOWED = new Set([
      'Компьютеры',
      'Принтеры',
      'Сканеры',
      'Сетевое оборудование',
      'Медицина',
      'Строительство',
      'Автотранспорт',
      'Продукты',
      'ГСМ',
      'Канцелярия',
      'Мебель',
      'Услуги',
      'Прочее',
    ]);
    const category = ALLOWED.has(input.analysis?.category)
      ? input.analysis.category
      : 'Прочее';

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
      category,
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

  // удалить просроченные: срок подачи известен и уже прошёл
  // (записи без deadlineAt не трогаем — вдруг не распарсился срок)
  async deleteExpired(): Promise<{ deleted: number }> {
    const res = await this.repo
      .createQueryBuilder()
      .delete()
      .from(Tender)
      .where('deadlineAt IS NOT NULL AND deadlineAt < :now', {
        now: new Date(),
      })
      .execute();
    return { deleted: res.affected ?? 0 };
  }

  async list(params: {
    verdict?: string;
    rating?: string;
    minSum?: number;
    minMargin?: number;
    minProfit?: number;
    analyzed?: boolean;
    activeOnly?: boolean;
    sortBy?: string;
    sortOrder?: string;
    page?: number;
    limit?: number;
    category?: string;
  }): Promise<{
    items: Tender[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    sortBy: string;
    sortOrder: 'ASC' | 'DESC';
  }> {
    const page = params.page && params.page > 0 ? params.page : 1;
    const limit = params.limit && params.limit > 0 ? params.limit : 50;

    // сортировка: только из whitelist, дефолт — дата публикации, новые сверху
    const sortBy =
      params.sortBy && SORTABLE[params.sortBy] ? params.sortBy : 'publishedAt';
    const sortOrder: 'ASC' | 'DESC' =
      String(params.sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const qb = this.repo
      .createQueryBuilder('t')
      .orderBy(SORTABLE[sortBy], sortOrder, 'NULLS LAST')
      .addOrderBy('t.id', 'DESC'); // стабильный tiebreaker

    if (params.category)
      qb.andWhere('t.category = :cat', { cat: params.category });
    if (params.verdict) qb.andWhere('t.verdict = :v', { v: params.verdict });
    if (params.rating) qb.andWhere('t.rating = :r', { r: params.rating });
    if (params.minSum) qb.andWhere('t.plannedSum >= :s', { s: params.minSum });
    if (params.minMargin !== undefined)
      qb.andWhere('t.margin >= :m', { m: params.minMargin });
    if (params.minProfit !== undefined)
      qb.andWhere('t.profit >= :p', { p: params.minProfit });
    if (params.analyzed) qb.andWhere('t.verdict IS NOT NULL');
    // только активные: срок подачи ещё не прошёл (записи без срока не показываем)
    if (params.activeOnly)
      qb.andWhere('t.deadlineAt > :now', { now: new Date() });

    qb.skip((page - 1) * limit).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      sortBy,
      sortOrder,
    };
  }

  // статистика для дашборда
  async stats(): Promise<any> {
    const totalRow = await this.repo
      .createQueryBuilder('t')
      .select('COUNT(*)', 'total')
      .addSelect('COALESCE(AVG(t.plannedSum), 0)', 'avgsum')
      .addSelect('COALESCE(SUM(t.plannedSum), 0)', 'totalsum')
      .getRawOne();

    // экономика: прибыль, рентабельность, счётчики по прибыльности/активности
    const eco = await this.repo
      .createQueryBuilder('t')
      .select('COALESCE(SUM(t.profit), 0)', 'totalprofit')
      .addSelect('AVG(t.margin)', 'avgmargin')
      .addSelect('COUNT(*) FILTER (WHERE t.profit > 0)', 'profitablecount')
      .addSelect("COUNT(*) FILTER (WHERE t.rating IN ('C','D'))", 'lowmargincount')
      .addSelect("COUNT(*) FILTER (WHERE t.rating = 'F')", 'losscount')
      .addSelect('COUNT(*) FILTER (WHERE t."deadlineAt" > NOW())', 'activecount')
      .addSelect(
        'COUNT(*) FILTER (WHERE t."createdAt"::date = CURRENT_DATE)',
        'newtoday',
      )
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

    // распределение по рейтингам A+ / A / B / C / D / F
    const byRatingRaw = await this.repo
      .createQueryBuilder('t')
      .select('t.rating', 'rating')
      .addSelect('COUNT(*)', 'count')
      .where('t.rating IS NOT NULL')
      .groupBy('t.rating')
      .getRawMany();

    const byRating = byRatingRaw.map((r) => ({
      rating: r.rating,
      count: parseInt(r.count, 10),
    }));

    const topOrgsRaw = await this.repo
      .createQueryBuilder('t')
      .select('t.organization', 'organization')
      .addSelect('COUNT(*)', 'count')
      .where('t.organization IS NOT NULL')
      .groupBy('t.organization')
      .orderBy('count', 'DESC')
      .limit(5)
      .getRawMany();

    const byCategoryRaw = await this.repo
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .where('t.category IS NOT NULL')
      .groupBy('t.category')
      .orderBy('count', 'DESC')
      .getRawMany();

    const byCategory = byCategoryRaw.map((r) => ({
      category: r.category,
      count: parseInt(r.count, 10),
    }));

    return {
      total: parseInt(totalRow.total, 10),
      avgSum: Math.round(parseFloat(totalRow.avgsum || 0)),
      totalSum: parseInt(totalRow.totalsum || 0, 10),

      // --- экономика (ТЗ: прибыль / рентабельность / счётчики) ---
      totalProfit: parseInt(eco.totalprofit || 0, 10),
      avgMargin:
        eco.avgmargin != null
          ? Math.round(parseFloat(eco.avgmargin) * 10) / 10
          : null,
      profitableCount: parseInt(eco.profitablecount, 10),
      lowMarginCount: parseInt(eco.lowmargincount, 10),
      lossCount: parseInt(eco.losscount, 10),
      activeCount: parseInt(eco.activecount, 10),
      newToday: parseInt(eco.newtoday, 10),

      byVerdict,
      byRating,
      byCategory,
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
