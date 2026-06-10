import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';

@Injectable()
export class AiService {
  private ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  // ---------- ДЕТАЛЬНАЯ СТРАНИЦА: полный анализ с веб-поиском ----------
  async analyze(text: string): Promise<any> {
    const prompt = `Ты эксперт по государственным закупкам Кыргызстана. Проанализируй закупку.

Для КАЖДОГО лота:
1. Определи тип: "товар", "услуга" или "работа".
2. Если ТОВАР — найди через поиск актуальные рыночные цены в Бишкеке (КР) и сравни с суммой лота. Укажи примерную рыночную цену и вывод: завышена/занижена/адекватна сумма закупки.
3. Если УСЛУГА или РАБОТА — оцени, адекватна ли заявленная сумма (без поиска цен товаров).

Затем дай ОБЩИЙ вывод по всей закупке.

Верни ответ СТРОГО в формате JSON без markdown и пояснений:
{
  "verdict": "Стоит участвовать" | "С осторожностью" | "Не рекомендуется",
  "verdictReason": "одно-два предложения почему",
  "lots": [
    {
      "name": "название лота",
      "type": "товар" | "услуга" | "работа",
      "procurementSum": "сумма из закупки",
      "marketPrice": "рыночная цена или null для услуг/работ",
      "priceVerdict": "завышена" | "занижена" | "адекватна" | "нет данных",
      "comment": "краткий комментарий по лоту"
    }
  ],
  "risks": ["риск 1", "риск 2"],
  "profitable": "оценка выгодности участия одним абзацем"
}

Данные закупки:
${text}`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }], // веб-поиск только здесь
      },
    });

    const raw = response.text ?? '';
    const parsed = this.extractJson(raw);

    const sources =
      response.candidates?.[0]?.groundingMetadata?.groundingChunks
        ?.map((c: any) => ({ title: c.web?.title ?? '', uri: c.web?.uri ?? '' }))
        .filter((s: any) => s.uri) ?? [];

    return { analysis: parsed, sources };
  }

  // ---------- СПИСОК: быстрая AI-оценка пачки, БЕЗ веб-поиска ----------
  async analyzeList(items: any[]): Promise<any> {
    // компактно перечисляем закупки для промпта
    const list = items
      .map(
        (it, i) =>
          `${i}. [${it.type}] "${it.name}" | сумма: ${it.plannedSum} сом | метод: ${it.method} | срок подачи: ${it.deadline} | заказчик: ${it.organization}`,
      )
      .join('\n');

    const prompt = `Ты эксперт по госзакупкам Кыргызстана. Сегодняшняя дата: ${new Date().toLocaleString('ru-RU')}.
Оцени привлекательность каждой закупки для потенциального поставщика ТОЛЬКО по этим данным (без поиска цен).

Приоритеты при оценке (по важности):
1) Срок подачи — если до дедлайна мало времени, привлекательность ниже.
2) Сумма — средние и крупные обычно интереснее совсем мелких.
3) Понятность предмета — чёткий конкретный предмет лучше размытого.

Для каждой закупки верни уровень: "высокая" | "средняя" | "низкая" и короткую причину (до 10 слов).

Верни СТРОГО JSON-массив без markdown, по индексам закупок:
[
  { "index": 0, "level": "высокая" | "средняя" | "низкая", "reason": "краткая причина" }
]

Закупки:
${list}`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      // без tools — никакого веб-поиска, быстро и дёшево
    });

    const raw = response.text ?? '';
    const parsed = this.extractJson(raw);

    return { scores: Array.isArray(parsed) ? parsed : [] };
  }

  // ---------- хелпер: достаём JSON даже если AI налепил текста вокруг ----------
  private extractJson(raw: string): any {
    // пробуем найти массив [...] или объект {...}
    const tryParse = (open: string, close: string) => {
      const start = raw.indexOf(open);
      const end = raw.lastIndexOf(close);
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    };
    return tryParse('[', ']') ?? tryParse('{', '}') ?? { raw };
  }
}