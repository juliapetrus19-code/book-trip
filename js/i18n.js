// BookTrip — UI strings (ru / uk / en) and the tiny i18n runtime. Owned by app.
// Keys are flat dotted names ("nav.how") so index.html can reference them via data-i18n.
// Values: string, string[] (lists) or { one, few, many, other } (plurals, see tn()).

import { store } from "./util.js";

export const LANGS = ["ru", "uk", "en"];
const LANG_KEY = "bt-lang";

export const STRINGS = {
  ru: {
    "brand.tagline": "Путешествие внутрь любой книги",
    "meta.title": "BookTrip — путешествие внутрь любой книги",
    "meta.description": "Введите название книги — и войдите внутрь: пересказ, важные термины, персонажи в 3D, похожие книги и мини-фильм о путешествии в историю.",
    "a11y.skip": "Перейти к содержимому",

    "nav.how": "Как это работает",
    "nav.library": "Библиотека",
    "nav.premium": "Премиум",
    "nav.cta": "Начать путешествие",
    "nav.lang": "Язык",
    "nav.menu": "Меню",
    "nav.home": "На главную",

    "mode.demo": "Демо-режим",
    "mode.live": "ИИ подключён",

    "home.badge": "AI-пересказ · персонажи в 3D · мини-фильм",
    "home.h1a": "Войди внутрь",
    "home.h1b": "любой книги",
    "home.sub": "Пересказ, важные термины, персонажи и мини-фильм — за минуту.",
    "home.searchLabel": "Название книги",
    "home.placeholder": "Например, «Маленький принц»",
    "home.placeholderTpl": "Например, «{example}»",
    "home.examples": ["Маленький принц", "Гарри Поттер", "Хоббит", "Алиса в Стране чудес", "1984", "Три мушкетёра", "Остров сокровищ", "Гордость и предубеждение"],
    "home.go": "Войти в книгу",
    "home.hint": "Нажмите на обложку — или крутаните полку пальцем.",
    "home.ringLabel": "Книги",

    "search.listLabel": "Подсказки",
    "search.searching": "Ищем «{q}»…",
    "search.notFound": "Не удалось найти «{q}». Проверьте название или попробуйте другое.",
    "search.didYouMean": "Возможно, вы имели в виду",
    "search.inLibrary": "В библиотеке",
    "search.askAi": "Найти «{q}» с помощью ИИ",
    "search.askAiHint": "Любая книга — пересказ за минуту",
    "search.noMatches": "В библиотеке такой книги нет",
    "search.noMatchesLive": "Нажмите Enter — найдём её с помощью ИИ",
    "search.noMatchesDemo": "Загляните во «Всю библиотеку» — там все открытые книги",
    "search.tooShort": "Введите название книги — хотя бы пару букв",
    "search.demoTitle": "ИИ пока не подключён",
    "search.demoText": "Попробуйте одну из этих книг — они открыты полностью: пересказ, герои в 3D и мини-фильм.",
    "search.demoQuery": "Книгу «{q}» мы найдём, как только подключим ИИ. А пока — загляните в одну из этих:",
    "search.allBooks": "Вся библиотека",

    "loading.kicker": "Открываем книгу",
    "loading.label": "Открываем книгу «{q}»",
    "loading.steps": ["Ищем книгу…", "Открываем обложку…", "Знакомимся с героями…", "Готовим путешествие…"],
    "loading.slow": "ИИ читает внимательно — это может занять до минуты.",
    "loading.cancel": "Отменить",
    "loading.cancelled": "Поиск отменён",

    "errors.network": "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.",
    "errors.timeout": "ИИ думает слишком долго. Попробуйте ещё раз чуть позже.",
    "errors.aborted": "Запрос отменён.",
    "errors.rate_limited": "Слишком много запросов. Передохните минуту — и продолжим.",
    "errors.refused": "ИИ не может рассказать об этой книге. Попробуйте другую.",
    "errors.not_configured": "ИИ пока не подключён — доступны книги из библиотеки.",
    "errors.not_found": "Книга не найдена.",
    "errors.upstream": "ИИ-сервис временно недоступен. Попробуйте ещё раз через минуту.",
    "errors.forbidden": "Доступ закрыт. Проверьте код премиум-доступа.",
    "errors.bad_request": "Странный запрос. Попробуйте сформулировать иначе.",
    "errors.bad_response": "Сервер ответил что-то непонятное. Попробуйте ещё раз.",
    "errors.generic": "Что-то пошло не так. Попробуйте ещё раз.",
    "errors.retry": "Повторить",
    "errors.needsCharacters": "Фильм появится, когда загрузятся персонажи.",
    "errors.bookMissing": "Такой книги нет в библиотеке.",

    "modal.close": "Закрыть",

    "how.kicker": "Как это работает",
    "how.title": "Четыре шага внутрь истории",
    "how.lead": "BookTrip превращает любую книгу в маленькое путешествие: прочитать за пять минут, понять глубже, запомнить надолго.",
    "how.s1.title": "Назовите книгу",
    "how.s1.text": "Напишите название — можно с опечаткой, по-русски, по-украински или по-английски. Или просто нажмите на обложку на полке.",
    "how.s2.title": "ИИ читает за вас",
    "how.s2.text": "Связный пересказ без воды, главные темы и словарик важных терминов — всё, чтобы понять историю целиком.",
    "how.s3.title": "Знакомьтесь с героями",
    "how.s3.text": "Каждый заметный персонаж — милая воксельная 3D-фигурка: покрутите её и узнайте, кто это и как он меняется по ходу сюжета.",
    "how.s4.title": "Отправляйтесь в мини-фильм",
    "how.s4.text": "Книга раскрывается, камера ныряет внутрь — и вы проживаете ключевые сцены вместе с героями под голос рассказчика.",
    "how.note": "А в конце — подборка похожих книг, чтобы путешествие продолжалось.",
    "how.cta": "Попробовать",

    "library.title": "Библиотека",
    "library.lead": "Книги, которые открыты полностью прямо сейчас: пересказ, герои в 3D и мини-фильм.",
    "library.count": { one: "{n} книга", few: "{n} книги", many: "{n} книг", other: "{n} книги" },
    "library.recent": "Вы недавно открывали",
    "library.liveNote": "Не нашли нужную? Введите любое название в поиске — ИИ откроет и её.",
    "library.demoNote": "Скоро здесь можно будет открыть любую книгу — мы подключаем ИИ.",
    "library.open": "Открыть «{title}»",
    "library.loading": "Расставляем книги по полкам…",

    "premium.kicker": "BookTrip Премиум",
    "premium.title": "Оживите любимых героев",
    "premium.lead": "Всё главное в BookTrip — бесплатно. Премиум добавляет то, что умеют только самые сильные визуальные модели: портреты героев и настоящие видеоролики по книге.",
    "premium.portraits.title": "ИИ-портреты героев",
    "premium.portraits.text": "Одно нажатие — и рядом с воксельной фигуркой появляется живописный портрет персонажа, написанный по описанию из книги.",
    "premium.video.title": "ИИ-видеоклипы",
    "premium.video.text": "Три кинематографичных 8-секундных клипа по ключевым сценам, снятых видеомоделью, — словно короткий трейлер к книге.",
    "premium.free.title": "Бесплатно навсегда",
    "premium.free.text": "Пересказ, термины, герои в 3D, похожие книги и мини-фильм — для всех и без регистрации.",
    "premium.pricing.title": "Как устроена оплата",
    "premium.pricing.items": [
      "Путешествие по любой книге — бесплатно.",
      "Портреты — тоже бесплатно, с честным лимитом в несколько штук в час.",
      "Видео — по коду премиум-доступа: каждый ролик рендерит настоящая видеомодель, поэтому это платная опция.",
      "Код вводится прямо на странице книги — без аккаунта и подписки.",
    ],
    "premium.status": "Сейчас на сайте",
    "premium.on": "доступно",
    "premium.off": "скоро",
    "premium.note": "Портреты и видео создаются по описаниям из книги и никогда не изображают реальных людей.",
    "premium.cta": "Выбрать книгу",

    "footer.note": "Пересказы и образы создаёт ИИ — они не заменяют чтение, а зовут к нему.",
    "footer.rights": "© {year} BookTrip",

    "toast.offline": "Похоже, пропал интернет.",
    "toast.partFailed": "Не удалось загрузить: {part}",

    "part.overview": "пересказ",
    "part.characters": "персонажи",
    "part.film": "мини-фильм",

    "book.back": "Назад",
    "book.loading": "Открываем книгу…",
    "book.summary": "Пересказ",
    "book.characters": "Персонажи",
    "book.film": "Мини-фильм",
    "year.bc": "{y} до н. э.",
  },

  uk: {
    "brand.tagline": "Подорож усередину будь-якої книги",
    "meta.title": "BookTrip — подорож усередину будь-якої книги",
    "meta.description": "Введіть назву книги — і увійдіть усередину: переказ, ключові терміни, персонажі в 3D, схожі книги та мініфільм про подорож в історію.",
    "a11y.skip": "Перейти до вмісту",

    "nav.how": "Як це працює",
    "nav.library": "Бібліотека",
    "nav.premium": "Преміум",
    "nav.cta": "Почати подорож",
    "nav.lang": "Мова",
    "nav.menu": "Меню",
    "nav.home": "На головну",

    "mode.demo": "Демо-режим",
    "mode.live": "ШІ під'єднано",

    "home.badge": "AI-переказ · персонажі в 3D · мініфільм",
    "home.h1a": "Увійди всередину",
    "home.h1b": "будь-якої книги",
    "home.sub": "Переказ, ключові терміни, персонажі та мініфільм — за хвилину.",
    "home.searchLabel": "Назва книги",
    "home.placeholder": "Наприклад, «Маленький принц»",
    "home.placeholderTpl": "Наприклад, «{example}»",
    "home.examples": ["Маленький принц", "Гаррі Поттер", "Гобіт", "Аліса в Країні Див", "1984", "Тіні забутих предків", "Острів скарбів", "Три мушкетери"],
    "home.go": "Увійти в книгу",
    "home.hint": "Натисніть на обкладинку — або крутніть полицю пальцем.",
    "home.ringLabel": "Книги",

    "search.listLabel": "Підказки",
    "search.searching": "Шукаємо «{q}»…",
    "search.notFound": "Не вдалося знайти «{q}». Перевірте назву або спробуйте іншу.",
    "search.didYouMean": "Можливо, ви мали на увазі",
    "search.inLibrary": "У бібліотеці",
    "search.askAi": "Знайти «{q}» за допомогою ШІ",
    "search.askAiHint": "Будь-яка книга — переказ за хвилину",
    "search.noMatches": "У бібліотеці такої книги немає",
    "search.noMatchesLive": "Натисніть Enter — знайдемо її за допомогою ШІ",
    "search.noMatchesDemo": "Зазирніть до «Усієї бібліотеки» — там усі відкриті книги",
    "search.tooShort": "Введіть назву книги — хоча б кілька літер",
    "search.demoTitle": "ШІ поки що не під'єднано",
    "search.demoText": "Спробуйте одну з цих книг — вони відкриті повністю: переказ, герої в 3D і мініфільм.",
    "search.demoQuery": "Книгу «{q}» ми знайдемо, щойно під'єднаємо ШІ. А поки — зазирніть до однієї з цих:",
    "search.allBooks": "Уся бібліотека",

    "loading.kicker": "Відкриваємо книгу",
    "loading.label": "Відкриваємо книгу «{q}»",
    "loading.steps": ["Шукаємо книгу…", "Відкриваємо обкладинку…", "Знайомимося з героями…", "Готуємо подорож…"],
    "loading.slow": "ШІ читає уважно — це може тривати до хвилини.",
    "loading.cancel": "Скасувати",
    "loading.cancelled": "Пошук скасовано",

    "errors.network": "Немає зв'язку із сервером. Перевірте інтернет і спробуйте ще раз.",
    "errors.timeout": "ШІ думає надто довго. Спробуйте ще раз трохи згодом.",
    "errors.aborted": "Запит скасовано.",
    "errors.rate_limited": "Забагато запитів. Перепочиньте хвилинку — і продовжимо.",
    "errors.refused": "ШІ не може розповісти про цю книгу. Спробуйте іншу.",
    "errors.not_configured": "ШІ поки що не під'єднано — доступні книги з бібліотеки.",
    "errors.not_found": "Книгу не знайдено.",
    "errors.upstream": "Сервіс ШІ тимчасово недоступний. Спробуйте ще раз за хвилину.",
    "errors.forbidden": "Доступ закрито. Перевірте код преміум-доступу.",
    "errors.bad_request": "Дивний запит. Спробуйте сформулювати інакше.",
    "errors.bad_response": "Сервер відповів щось незрозуміле. Спробуйте ще раз.",
    "errors.generic": "Щось пішло не так. Спробуйте ще раз.",
    "errors.retry": "Повторити",
    "errors.needsCharacters": "Фільм з'явиться, щойно завантажаться персонажі.",
    "errors.bookMissing": "Такої книги немає в бібліотеці.",

    "modal.close": "Закрити",

    "how.kicker": "Як це працює",
    "how.title": "Чотири кроки всередину історії",
    "how.lead": "BookTrip перетворює будь-яку книгу на маленьку подорож: прочитати за п'ять хвилин, зрозуміти глибше, запам'ятати надовго.",
    "how.s1.title": "Назвіть книгу",
    "how.s1.text": "Напишіть назву — можна з помилкою, українською, російською чи англійською. Або просто натисніть на обкладинку на полиці.",
    "how.s2.title": "ШІ читає за вас",
    "how.s2.text": "Зв'язний переказ без води, головні теми та словничок важливих термінів — усе, щоб зрозуміти історію цілком.",
    "how.s3.title": "Знайомтеся з героями",
    "how.s3.text": "Кожен помітний персонаж — мила воксельна 3D-фігурка: покрутіть її та дізнайтеся, хто це і як він змінюється впродовж сюжету.",
    "how.s4.title": "Вирушайте в мініфільм",
    "how.s4.text": "Книга розгортається, камера пірнає всередину — і ви проживаєте ключові сцени разом із героями під голос оповідача.",
    "how.note": "А наприкінці — добірка схожих книг, щоб подорож тривала.",
    "how.cta": "Спробувати",

    "library.title": "Бібліотека",
    "library.lead": "Книги, відкриті повністю просто зараз: переказ, герої в 3D і мініфільм.",
    "library.count": { one: "{n} книга", few: "{n} книги", many: "{n} книг", other: "{n} книги" },
    "library.recent": "Ви нещодавно відкривали",
    "library.liveNote": "Не знайшли потрібної? Введіть будь-яку назву в пошуку — ШІ відкриє і її.",
    "library.demoNote": "Незабаром тут можна буде відкрити будь-яку книгу — ми під'єднуємо ШІ.",
    "library.open": "Відкрити «{title}»",
    "library.loading": "Розставляємо книги на полицях…",

    "premium.kicker": "BookTrip Преміум",
    "premium.title": "Оживіть улюблених героїв",
    "premium.lead": "Усе головне в BookTrip — безкоштовно. Преміум додає те, що вміють лише найсильніші візуальні моделі: портрети героїв і справжні відеокліпи за книгою.",
    "premium.portraits.title": "ШІ-портрети героїв",
    "premium.portraits.text": "Один дотик — і поруч із воксельною фігуркою з'являється мальовничий портрет персонажа, написаний за описом із книги.",
    "premium.video.title": "ШІ-відеокліпи",
    "premium.video.text": "Три кінематографічні восьмисекундні кліпи за ключовими сценами, зняті відеомоделлю, — наче короткий трейлер до книги.",
    "premium.free.title": "Безкоштовно назавжди",
    "premium.free.text": "Переказ, терміни, герої в 3D, схожі книги та мініфільм — для всіх і без реєстрації.",
    "premium.pricing.title": "Як влаштована оплата",
    "premium.pricing.items": [
      "Подорож будь-якою книгою — безкоштовна.",
      "Портрети — теж безкоштовно, з чесним лімітом у кілька штук на годину.",
      "Відео — за кодом преміум-доступу: кожен кліп рендерить справжня відеомодель, тож це платна опція.",
      "Код вводиться просто на сторінці книги — без акаунта й підписки.",
    ],
    "premium.status": "Зараз на сайті",
    "premium.on": "доступно",
    "premium.off": "незабаром",
    "premium.note": "Портрети й відео створюються за описами з книги та ніколи не зображують реальних людей.",
    "premium.cta": "Обрати книгу",

    "footer.note": "Перекази й образи створює ШІ — вони не замінюють читання, а кличуть до нього.",
    "footer.rights": "© {year} BookTrip",

    "toast.offline": "Схоже, зник інтернет.",
    "toast.partFailed": "Не вдалося завантажити: {part}",

    "part.overview": "переказ",
    "part.characters": "персонажі",
    "part.film": "мініфільм",

    "book.back": "Назад",
    "book.loading": "Відкриваємо книгу…",
    "book.summary": "Переказ",
    "book.characters": "Персонажі",
    "book.film": "Мініфільм",
    "year.bc": "{y} р. до н. е.",
  },

  en: {
    "brand.tagline": "Step inside any book",
    "meta.title": "BookTrip — step inside any book",
    "meta.description": "Type a book title and step inside: a retelling, key terms, 3D characters, similar books and a mini-film journey into the story.",
    "a11y.skip": "Skip to content",

    "nav.how": "How it works",
    "nav.library": "Library",
    "nav.premium": "Premium",
    "nav.cta": "Start the trip",
    "nav.lang": "Language",
    "nav.menu": "Menu",
    "nav.home": "Home",

    "mode.demo": "Demo mode",
    "mode.live": "AI connected",

    "home.badge": "AI retelling · 3D characters · mini-film",
    "home.h1a": "Step inside",
    "home.h1b": "any book",
    "home.sub": "A retelling, key terms, the characters and a mini-film — in a minute.",
    "home.searchLabel": "Book title",
    "home.placeholder": "Try “The Little Prince”",
    "home.placeholderTpl": "Try “{example}”",
    "home.examples": ["The Little Prince", "Harry Potter", "The Hobbit", "Alice in Wonderland", "1984", "The Three Musketeers", "Treasure Island", "Pride and Prejudice"],
    "home.go": "Enter the book",
    "home.hint": "Tap a cover — or give the shelf a spin.",
    "home.ringLabel": "Books",

    "search.listLabel": "Suggestions",
    "search.searching": "Looking for “{q}”…",
    "search.notFound": "We couldn't find “{q}”. Check the title or try another one.",
    "search.didYouMean": "Did you mean",
    "search.inLibrary": "In the library",
    "search.askAi": "Find “{q}” with AI",
    "search.askAiHint": "Any book — a retelling in a minute",
    "search.noMatches": "This book isn't in the library",
    "search.noMatchesLive": "Press Enter — AI will find it",
    "search.noMatchesDemo": "Open “The whole library” to see every available book",
    "search.tooShort": "Type a book title — at least a couple of letters",
    "search.demoTitle": "AI is not connected yet",
    "search.demoText": "Try one of these books — they're fully open: retelling, 3D characters and a mini-film.",
    "search.demoQuery": "We'll find “{q}” as soon as AI is connected. Meanwhile, step inside one of these:",
    "search.allBooks": "The whole library",

    "loading.kicker": "Opening the book",
    "loading.label": "Opening “{q}”",
    "loading.steps": ["Finding the book…", "Opening the cover…", "Meeting the characters…", "Preparing your trip…"],
    "loading.slow": "AI is reading carefully — this can take up to a minute.",
    "loading.cancel": "Cancel",
    "loading.cancelled": "Search cancelled",

    "errors.network": "Can't reach the server. Check your connection and try again.",
    "errors.timeout": "AI is taking too long. Please try again in a moment.",
    "errors.aborted": "Request cancelled.",
    "errors.rate_limited": "Too many requests. Take a one-minute breather and we'll carry on.",
    "errors.refused": "AI can't tell this story. Try another book.",
    "errors.not_configured": "AI isn't connected yet — the library books are available.",
    "errors.not_found": "Book not found.",
    "errors.upstream": "The AI service is temporarily unavailable. Try again in a minute.",
    "errors.forbidden": "Access denied. Check your premium code.",
    "errors.bad_request": "That request looks odd. Try phrasing it differently.",
    "errors.bad_response": "The server sent something unexpected. Please try again.",
    "errors.generic": "Something went wrong. Please try again.",
    "errors.retry": "Retry",
    "errors.needsCharacters": "The film appears once the characters have loaded.",
    "errors.bookMissing": "This book isn't in the library.",

    "modal.close": "Close",

    "how.kicker": "How it works",
    "how.title": "Four steps into the story",
    "how.lead": "BookTrip turns any book into a small journey: read it in five minutes, understand it more deeply, remember it for longer.",
    "how.s1.title": "Name a book",
    "how.s1.text": "Type a title — typos welcome, in English, Ukrainian or Russian. Or simply tap a cover on the shelf.",
    "how.s2.title": "AI reads it for you",
    "how.s2.text": "A clear retelling without the fluff, the main themes and a glossary of key terms — everything you need to grasp the whole story.",
    "how.s3.title": "Meet the characters",
    "how.s3.text": "Every notable character becomes a cute voxel 3D figure: spin it around, learn who they are and how they change along the way.",
    "how.s4.title": "Dive into the mini-film",
    "how.s4.text": "The book opens, the camera dives in — and you live through the key scenes with the characters, told by a narrator.",
    "how.note": "And at the end — a shelf of similar books, so the journey goes on.",
    "how.cta": "Try it",

    "library.title": "Library",
    "library.lead": "Books that are fully open right now: retelling, 3D characters and a mini-film.",
    "library.count": { one: "{n} book", other: "{n} books" },
    "library.recent": "Recently opened",
    "library.liveNote": "Didn't find yours? Type any title into search — AI will open it too.",
    "library.demoNote": "Soon you'll be able to open any book here — we're connecting the AI.",
    "library.open": "Open “{title}”",
    "library.loading": "Putting the books on the shelves…",

    "premium.kicker": "BookTrip Premium",
    "premium.title": "Bring the characters to life",
    "premium.lead": "Everything essential in BookTrip is free. Premium adds what only the most capable visual models can create — character portraits and real video clips of the book.",
    "premium.portraits.title": "AI character portraits",
    "premium.portraits.text": "One tap — and a painterly portrait appears next to the voxel figure, drawn from the book's own description.",
    "premium.video.title": "AI video clips",
    "premium.video.text": "Three cinematic 8-second clips of key scenes, shot by a video model — like a short trailer for the book.",
    "premium.free.title": "Free forever",
    "premium.free.text": "Retelling, terms, 3D characters, similar books and the mini-film — for everyone, no sign-up.",
    "premium.pricing.title": "How pricing works",
    "premium.pricing.items": [
      "A trip through any book is free.",
      "Portraits are free too, with a fair limit of a few per hour.",
      "Video is unlocked with a premium access code: every clip is rendered by a real video model, so it's a paid extra.",
      "You enter the code right on the book page — no account, no subscription.",
    ],
    "premium.status": "Right now",
    "premium.on": "available",
    "premium.off": "coming soon",
    "premium.note": "Portraits and videos are generated from the book's descriptions and never depict real people.",
    "premium.cta": "Pick a book",

    "footer.note": "Retellings and images are made by AI — not a replacement for reading, but an invitation to it.",
    "footer.rights": "© {year} BookTrip",

    "toast.offline": "Looks like you're offline.",
    "toast.partFailed": "Couldn't load: {part}",

    "part.overview": "retelling",
    "part.characters": "characters",
    "part.film": "mini-film",

    "book.back": "Back",
    "book.loading": "Opening the book…",
    "book.summary": "Retelling",
    "book.characters": "Characters",
    "book.film": "Mini-film",
    "year.bc": "{y} BC",
  },
};

let current = null;

function detectLang() {
  const saved = store.get(LANG_KEY);
  if (LANGS.includes(saved)) return saved;
  const list = (typeof navigator !== "undefined" && (navigator.languages?.length ? navigator.languages : [navigator.language])) || [];
  for (const raw of list) {
    const code = String(raw || "").toLowerCase().split(/[-_]/)[0];
    if (code === "uk") return "uk";
    if (code === "ru" || code === "be" || code === "kk") return "ru";
    if (code === "en") return "en";
  }
  return "en";
}

export function getLang() {
  if (!current) current = detectLang();
  return current;
}

/** Switch language: persist, update <html lang> and meta, notify listeners via window "bt:lang". */
export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  const changed = lang !== getLang();
  current = lang;
  store.set(LANG_KEY, lang);
  syncDocumentLang();
  if (changed) window.dispatchEvent(new CustomEvent("bt:lang", { detail: { lang } }));
}

function syncDocumentLang() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = getLang();
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.setAttribute("content", t("meta.description"));
}

function lookup(key, lang) {
  const table = STRINGS[lang] || STRINGS.en;
  if (key in table) return table[key];
  if (key in STRINGS.en) return STRINGS.en[key];
  return undefined;
}

function fill(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
}

/** Translate `key` for the current language. Lists come back as arrays, strings get {var} interpolation. */
export function t(key, vars) {
  const value = lookup(key, getLang());
  if (value === undefined) return key;
  if (Array.isArray(value)) return vars ? value.map((s) => fill(s, vars)) : value;
  if (typeof value === "object") return fill(value.other ?? Object.values(value)[0], vars);
  return fill(value, vars);
}

/** Plural-aware translation: tn("library.count", 5) → "5 книг". `{n}` is filled automatically. */
export function tn(key, n, vars = {}) {
  const lang = getLang();
  const value = lookup(key, lang);
  if (value === undefined) return key;
  if (typeof value === "string") return fill(value, { n, ...vars });
  let cat = "other";
  try { cat = new Intl.PluralRules(lang).select(n); } catch { /* old engines */ }
  return fill(value[cat] ?? value.other ?? value.many ?? "", { n, ...vars });
}

/** Human year: 1943 → "1943", -800 → "800 до н. э.", null → "". */
export function formatYear(year) {
  if (!Number.isFinite(year)) return "";
  return year < 0 ? t("year.bc", { y: -year }) : String(year);
}

/** Fill [data-i18n] (textContent), [data-i18n-ph] (placeholder), [data-i18n-aria] (aria-label), [data-i18n-title] (title). */
export function applyI18n(root = document) {
  if (root === document) syncDocumentLang();
  for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll("[data-i18n-ph]")) node.setAttribute("placeholder", t(node.dataset.i18nPh));
  for (const node of root.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));
  for (const node of root.querySelectorAll("[data-i18n-title]")) node.setAttribute("title", t(node.dataset.i18nTitle));
}
