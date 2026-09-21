// Разбор банковских SMS. Общий код: его использует и приложение (index.html), и сервер (inbox-worker).
// parseBankText(text) →
//   { ok: false }                                             — сумма не найдена
//   { ok: false, amount, sym }                                — сумма есть, но не ясно, расход это или заработок
//   { ok: true, type: 'transfer', amount, sym, avail }        — перевод: в учёт не идёт
//   { ok: true, type: 'expense'|'income', amount, sym, merchant, category, avail }
(function (root) {
  const CUR_TOKENS = '(₽|руб(?:\\.|лей|ля)?|р\\.?|RUB|RUR|\\$|USD|€|EUR|֏|AMD|драм\\w*|₸|KZT|₴|UAH|грн\\.?)';
  const PRE_TOKENS = '(\\$|€|₽|₸|₴|֏|USD|EUR|RUB|AMD|KZT|UAH)';
  const NUM = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  const SYMBOL = { '₽': '₽', 'руб': '₽', 'р': '₽', 'rub': '₽', 'rur': '₽', '$': '$', 'usd': '$', '€': '€', 'eur': '€', '֏': '֏', 'amd': '֏', 'драм': '֏', '₸': '₸', 'kzt': '₸', '₴': '₴', 'uah': '₴', 'грн': '₴' };

  const EXPENSE_GUESS = [
    ['Продукты', /magnit|магнит|пят[её]рочк|перекр[её]ст|лента|ашан|дикси|вкусвилл|spar\b|азбука вкуса|продукт|supermarket|grocery|marketplace|market\b/],
    ['Кафе и рестораны', /kfc|burger|mcdonald|макдон|starbucks|кофе|cafe|кафе|ресторан|restaurant|pizza|пицц|додо|sushi|суши|вкусно|delivery club|яндекс.?еда|yandex.?eda|бар\b/],
    ['Транспорт', /taxi|такси|uber|yandex.?go|яндекс.?go|метро|metro|ржд|rzd|аэрофлот|\bазс\b|лукойл|роснефть|газпромнефть|parking|парков|автобус|transport|тройка/],
    ['Связь и интернет', /\bмтс\b|mts|beeline|билайн|megafon|мегафон|tele2|теле2|ростелеком|yota|интернет|internet/],
    ['Здоровье', /аптек|apteka|pharm|clinic|клиник|стоматолог|горздрав|36\.6|медицин|лаборатор/],
    ['Одежда', /zara|h&m|lamoda|uniqlo|одежд|обув|спортмастер|sportmaster|befree|gloria/],
    ['Развлечения', /cinema|кино|netflix|spotify|steam|playstation|\bivi\b|okko|театр|concert|билет|игр/],
    ['Жильё и коммуналка', /жкх|жку|коммунал|квартплат|электроэнерг|мосэнерго|водоканал|аренд|\brent\b|ипотек/],
    ['Образование', /школ|университет|курс|udemy|skillbox|coursera|образован|репетитор/],
    ['Питомцы', /petshop|зоомагазин|\bzoo|ветеринар|petstore|четыре лапы/],
  ];
  const INCOME_GUESS = [
    ['Зарплата', /зарплат|salary|аванс|заработн/],
    ['Возврат', /возврат|refund|cashback|кэшбэк|кешбэк/],
    ['Проценты и инвестиции', /процент|interest|дивиденд|купон/],
  ];
  const TRANSFER_RE = /(перевод|перевел|перевёл|переведен|переведён|transfer|p2p|c2c|\bсбп\b|между (?:своими )?счетами|с карты на карту|накопительн)/i;
  const SALARY_RE = /(зарплат|заработн|salary|аванс)/i;

  // Ищет первую денежную сумму: «500 RUB», «1 250,50р», «$12.99»
  function findMoney(s) {
    let m = s.match(new RegExp(NUM + '\\s*' + CUR_TOKENS + '(?![a-zа-яё\\d])', 'i'));
    if (m) return { num: m[1], tok: m[2], end: m.index + m[0].length };
    m = s.match(new RegExp(PRE_TOKENS + '\\s*' + NUM, 'i'));
    if (m) return { num: m[2], tok: m[1], end: m.index + m[0].length };
    return null;
  }
  const toNumber = num => parseFloat(num.replace(/[  ]/g, '').replace(',', '.'));

  function parseBankText(raw) {
    const t = String(raw || '').replace(/[ \s]+/g, ' ').replace(/\*+\s?\d{2,4}/g, ' ').trim();   // без номеров карт
    const cut = t.search(/(доступно|баланс|остаток|остат\.|balance|available|\bbal\b)/i);
    const head = cut > 0 ? t.slice(0, cut) : t;                 // до слов про остаток: там нужная сумма
    const found = findMoney(head);
    if (!found) return { ok: false };
    const amount = toNumber(found.num);
    if (!(amount > 0)) return { ok: false };
    const key = found.tok.toLowerCase().replace(/[.\s]/g, '').replace(/^руб.*/, 'руб').replace(/^драм.*/, 'драм').replace(/^грн.*/, 'грн');
    const sym = SYMBOL[key];
    const availFound = cut > 0 ? findMoney(t.slice(cut)) : null;
    const avail = availFound ? toNumber(availFound.num) : null;   // остаток на карте после операции

    // Переводы (между своими счетами, другому человеку, по СБП) — не расход и не заработок.
    // Исключение — зарплата, которая тоже может приходить «переводом».
    if (!SALARY_RE.test(head) && TRANSFER_RE.test(head)) return { ok: true, type: 'transfer', amount, sym, avail };

    const isInc = /(зачислен|поступлен|пополнен|получен|начислен|зарплат|аванс|возврат|refund|credit|deposit|входящ|перевод от|cashback|кэшбэк|кешбэк)/i.test(head);
    const isExp = /(покупк|оплат|списан|снят|расход|purchase|payment|withdraw|debit|pokupka|oplata|перевод (?:на|клиент)|отправлен|платеж|платёж)/i.test(head);
    const type = isInc ? 'income' : isExp ? 'expense' : null;
    if (!type) return { ok: false, amount, sym };

    const merchant = head.slice(found.end).replace(/^[\s.,;:|\-–—]+/, '').replace(/^(at|в|в магазине)\s+/i, '')
      .split(/\s*[;|]\s*|\.\s+|,\s+|\.$/).map(s => s.trim())
      .filter(s => s.length > 1 && !/^(карт|karta|card|сч[её]т|schet|visa|mastercard|mir|мир)(\s|$)/i.test(s))[0] || '';
    const hay = (merchant + ' ' + head).toLowerCase();
    const table = type === 'income' ? INCOME_GUESS : EXPENSE_GUESS;
    const category = (table.find(([, re]) => re.test(hay)) || [type === 'income' ? 'Другое' : 'Прочее'])[0];
    return { ok: true, type, amount, sym, merchant: merchant.slice(0, 40), category, avail };
  }

  root.parseBankText = parseBankText;
})(typeof globalThis !== 'undefined' ? globalThis : self);
