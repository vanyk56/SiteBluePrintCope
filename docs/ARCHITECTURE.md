# site-blueprint 2.0 — архитектура

```text
 ┌──────────────────────────── источники ─────────────────────────────┐
 URL ─► src/crawler.mjs (Playwright)              extension/ (Chrome MV3, браузер пользователя)
        src/browser.mjs   блокировка трекеров     popup.js ─► background.js (service worker, задача живёт без попапа)
        src/core/hooks.mjs плагины                 ├─ lib/hooks.js + inject/api-hook.js   (MAIN world, document_start)
        src/inpage/hooks.mjs init-скрипт           ├─ lib/inpage.js + content.js          (живой DOM, пробы, снимок)
        src/capture/network.mjs API-сниффер        └─ lib/package.js + lib/zip.js         (ZIP, формат v1)
        src/crawl/pageops.mjs скролл, пробы,              │ «Скачать ZIP»            │ «Отправить в локальный CLI»
                              скриншоты                   ▼ download.html → Downloads ▼ POST 127.0.0.1:3005/capture
        src/crawl/saveassets.mjs + assets.mjs     site-blueprint import <zip>   src/server/listen.mjs (очередь задач)
        src/net/fetch.mjs + filenames.mjs                 └──────────► src/capture/import.mjs (zipread, png, redact)
        src/capture/snapshot.mjs (SingleFile)                                  │
                 │                                                             │
                 └──────────► единый формат результата: data/crawl.json, data/pages/*.json, screenshots/,
                              data/snapshots/, data/api-mocks/, project/public/…
                                                   │
                      src/cli.mjs runPipeline()    ▼
   analyze/site.mjs ─ секции, общие блоки, повторы → шаблон + данные, токены (analyze/tokens, tailwind, cssvars, svg)
   output/project.mjs ─ Next.js 16 + React 19 + Tailwind v4 (analyze/skeleton.mjs → TSX, analyze/jsxfix.mjs)
        output/interactive.mjs ─ "use client": MobileMenu, Modal, Cart, Disclosure, вкладки, каталог (lib/catalog.ts)
        output/api.mjs         ─ mocks/registry.ts + mocks/data/*.json + lib/mock-api.ts + app/api/[...route]/route.ts
        output/theme.mjs, output/content.mjs ─ globals.css (@theme), content/*.md
   llm/run.mjs ─ разбор скриншотов и данных (llm/client.mjs: OpenAI-совместимый API, повторы, кэш data/llm/)
   blueprint.mjs ─ SITE_CLONE_BLUEPRINT.md (+ pages/*.md, если документ большой)
   verify/selfcheck.mjs ─ build.mjs: ensureDeps → healProject (next build → правила → LLM-патчи → повтор)
                          server.mjs: next start на свободном порту · visual.mjs: pixelmatch → VERIFICATION_REPORT.md
   output/zip.mjs ─ <папка>.zip для ИИ-кодера
```

Захват из любого источника приводится к одной раскладке папки результата. Анализ, генерация и самопроверка не знают, откуда пришли данные: `import` и `listen` после импорта вызывают тот же `runPipeline()`, что и краулер.

## Карта модулей

| Путь | Назначение |
| --- | --- |
| `bin/site-blueprint.mjs` | точка входа CLI |
| `src/cli.mjs` | команды (`<url>`, `--from`, `import`, `listen`, `heal`, `verify`) и `runPipeline()`: анализ → проект → LLM → блюпринт → самопроверка → архив |
| `src/config.mjs` | разбор аргументов, `.env`, пресеты LLM-провайдеров, `HELP` |
| `src/crawler.mjs` | очередь обхода (глубина, sitemap, `--per-template`, robots), пауза между страницами (`--delay`, `crawl-delay`), страницы с ответом 4xx/5xx пропускаются, два вьюпорта на страницу |
| `src/browser.mjs` | запуск Chromium / своего браузера (`--browser-path`, `--channel`), блокировка трекеров на уровне сети |
| `src/core/hooks.mjs` | плагины в стиле website-scraper: `HOOKS`, `emit` / `waterfall` / `first`, загрузка `--plugin` и `SB_PLUGINS` |
| `src/crawl/pageops.mjs` | ожидание стабильности, cookie-баннеры, `autoScroll` / `forceLazy`, скриншоты, кадры для LLM, пробы |
| `src/crawl/robots.mjs` | robots.txt (`Allow`/`Disallow` с `*` и `$`, побеждает самое длинное правило, `crawl-delay`, запреты для ИИ-ботов) + чтение sitemap.xml |
| `src/crawl/assets.mjs` | хранилище `project/public/{images,svg,fonts,icons,media}`: дедуп по SHA-256 содержимого, уникальные имена, хук `generateFilename`, повторы |
| `src/crawl/saveassets.mjs` | скачивание ассетов страницы и замена `url(...)` / `src` / `srcset` на локальные пути (общий для краулера и импорта) |
| `src/net/fetch.mjs` | устойчивая загрузка в стиле HTTrack: backoff + jitter, `Retry-After`, докачка `Range`/`If-Range` и `*.part`, idle-таймаут, лимит размера; `HostThrottle` — параллелизм на хост и интервал, который растёт при 429/503 и снижается при успехе |
| `src/net/filenames.mjs` | чистые и безопасные для Windows имена: без query, разворачивание image-CDN, транслитерация, ≤ 60 символов |
| `src/inpage/hooks.mjs` | init-скрипт до скриптов страницы: закрытые shadow root, WebGL с `preserveDrawingBuffer`, шрифты из `new FontFace()` (только наблюдает) |
| `src/inpage/prepare.mjs` | lazy-картинки → eager, `data-src` → `src`, пошаговый скролл, ожидание шрифтов и картинок, доигрывание анимаций |
| `src/inpage/extract.mjs` | дерево DOM с computed CSS, токены, шрифты, медиа, SVG, интерактивные элементы |
| `src/inpage/probes.mjs` | пробы: вкладки и фильтры, аккордеоны, `<details>`, hover-меню, диалоги и выдвижные панели |
| `src/inpage/snapshot.mjs` | сериализатор SingleFile: живой DOM + CSSOM, `::before/::after`, Shadow DOM, same-origin iframe, canvas, состояние форм; ресурсы — плейсхолдеры `__SBRES_*` |
| `src/capture/snapshot.mjs` | Node-часть снимков: `data/snapshots/*.raw.json` → `snapshots/*.html` (локальные ассеты, ссылки между страницами, санитайзер) |
| `src/capture/network.mjs` | API-сниффер: XHR/fetch, GraphQL по `operationName`, фильтр шума, удаление cache-busters, лимиты → `data/api-mocks/` |
| `src/capture/redact.mjs` | маскирование секретов и PII (общий код с расширением) |
| `src/capture/zipread.mjs` | ZIP-ридер (store + deflate, data descriptors): zip-slip, лимиты, защита от zip-бомб, CRC |
| `src/capture/png.mjs` | кропы секций и «листы» для LLM из PNG, пришедших из расширения (pngjs) |
| `src/capture/import.mjs` | импорт захвата формата v1 в раскладку краулера, догрузка недостающих ассетов (кроме `--offline`) |
| `src/server/listen.mjs` | локальный приёмник для расширения (безопасность — ниже) |
| `src/sanitize/trackers.mjs` | каталог трекеров, рекламы, колл-трекинга и чат-виджетов: хосты, inline-сигнатуры, извлечение ID счётчиков |
| `src/sanitize/html.mjs` | санитайзер HTML снимков и DOM: скрипты, гидратация, пиксели, `<base>`, meta refresh/CSP, inline-обработчики, `javascript:` |
| `src/analyze/*` | `site.mjs` (сборка сайта из страниц), `sections.mjs`, `page.mjs`, `tree.mjs`, `tokens.mjs`, `tailwind.mjs`, `cssvars.mjs` (санитайзер CSS для Tailwind v4 / Lightning CSS), `svg.mjs`, `skeleton.mjs` (TSX), `jsxfix.mjs` |
| `src/output/*` | `project.mjs`, `interactive.mjs`, `api.mjs`, `theme.mjs`, `content.mjs`, `zip.mjs` |
| `src/llm/*` | `client.mjs` (OpenAI-совместимый клиент, vision fallback, повторы), `prompts.mjs`, `run.mjs` (анализ страниц, кэш) |
| `src/blueprint.mjs` | `SITE_CLONE_BLUEPRINT.md` |
| `src/verify/*` | `selfcheck.mjs`, `build.mjs`, `server.mjs`, `visual.mjs`, `index.mjs` (команда `verify`); `src/verify.mjs` — совместимый вход |
| `extension/` | расширение Chrome (ниже и в `extension/README.md`) |
| `scripts/build-extension.mjs` | генерирует общий с CLI код расширения и синхронизирует версию; `--check` — проверка актуальности |
| `examples/plugin-example.mjs` | пример плагина |
| `test/` | `unit/*.test.mjs` (79 тестов), `run-local-test.mjs` (E2E на фикстуре), `extension-e2e.mjs`, `serve.mjs`, `mock-llm.mjs`, `fixture/` |

## Что взято из эталонных проектов

| Проект | Механика | Где у нас |
| --- | --- | --- |
| SingleFile / single-file-cli | сериализация живого DOM и CSSOM после JS, `::before/::after`, Shadow DOM (в т.ч. закрытый), canvas/WebGL (`preserveDrawingBuffer`), шрифты из `new FontFace()`, дедуп ресурсов, удаление скриптов | `src/inpage/snapshot.mjs`, `src/inpage/hooks.mjs`, `src/capture/snapshot.mjs`, `extension/content.js` |
| website-scraper | хуки и плагины (`beforeRequest`, `afterResponse`, `generateFilename`, `onAssetSaved`…), «умный» скролл до низа, обход ссылок с глубиной | `src/core/hooks.mjs`, `src/crawl/pageops.mjs`, `src/inpage/prepare.mjs`, `src/crawler.mjs` |
| HTTrack | повторы с backoff и `Retry-After`, докачка `Range`, дедуп по хэшу, имена без `?v=` (`style.css?v=1.2 → style.css`), паузы между страницами, замедление загрузок при 429/503 | `src/net/fetch.mjs`, `src/net/filenames.mjs`, `src/crawl/assets.mjs`, `src/crawler.mjs` |
| PyWebCopy | строгие каталоги `public/images`, `public/svg`, `public/fonts`, `public/icons`, `public/media` и переписывание всех путей | `src/crawl/assets.mjs`, `src/crawl/saveassets.mjs`, `src/capture/snapshot.mjs` |
| AI Website Cloner Template | глубокая санитизация (трекеры, пиксели, виджеты), нейтрализация чужих роутеров и гидратации, чистый React 19 + Tailwind v4 | `src/sanitize/*`, `src/analyze/skeleton.mjs`, `src/output/*` |

## Общий код CLI и расширения

`scripts/build-extension.mjs` собирает части расширения из исходников CLI, поэтому обе стороны выполняют один и тот же код:

| Файл расширения | Источник | Где выполняется |
| --- | --- | --- |
| `extension/lib/inpage.js` | `src/inpage/{extract,snapshot,prepare,probes}.mjs` → `window.__sbLib` | вкладка, MAIN world |
| `extension/lib/hooks.js` | `src/inpage/hooks.mjs` | вкладка, MAIN world, `document_start` |
| `extension/lib/redact.js` | `src/capture/redact.mjs` | service worker |

Сгенерированные функции должны быть самодостаточными, потому что сериализуются через `Function.prototype.toString`. Тест `extension.test.mjs` проверяет это в `vm`. Версия в `manifest.json` всегда равна версии в `package.json`. `--check` завершается с кодом 1, если сгенерированные файлы устарели.

## Расширение (MV3)

- **`popup.js`** хранит настройки (`chrome.storage`), запрашивает разрешения внутри клика (нужен жест пользователя) и показывает прогресс. Задача выполняется в service worker и не прерывается, если попап закрыть.
- **`background.js`** (service worker, модуль) ведёт задачу:
  1. Вставляет `lib/inpage.js` + `content.js`. Для API-хука `lib/hooks.js` + `inject/api-hook.js` регистрируются на `document_start` (при перезагрузке или обходе сайта) или вставляются по требованию.
  2. `content.js`: prepare (lazy-load, пошаговый скролл, шрифты, анимации, inline SVG-спрайтов) → тексты CSS (cross-origin таблицы, которые страница прочитать не может, дочитывает service worker) → extract → snapshot.
  3. Скриншот всей страницы: прокрутка + `captureVisibleTab` (не чаще 2 раз в секунду) + склейка в `OffscreenCanvas`, высота до 16000px.
  4. Пробы интерактивного стейта: вкладки и фильтры, аккордеоны, диалоги, hover-меню, `<details>`.
  5. API-ответы: копии из хука плюс повторное чтение по Resource Timing (при необходимости — перезагрузка с хуком на `document_start`). `webRequest` ведёт учёт запросов вкладки (сетевой простой, статус документа, список XHR) — только наблюдение, ничего не блокирует и не меняет.
  6. Ассеты: fetch из service worker, при неудаче — из страницы. Остальное CLI докачает сам.
  7. `CapturePackager` → ZIP. «Скачать ZIP»: Blob через IndexedDB (`lib/idb.js`) передаётся в `download.html`, который создаёт `blob:` URL для `chrome.downloads` (service worker этого не умеет). «Отправить в CLI»: `POST http://127.0.0.1:<port>/capture`, затем опрос `/jobs/<id>`.
- **«Клонировать сайт»** открывает отдельное окно и обходит ссылки того же origin с глубиной и лимитом страниц. Учитываются `robots.txt` и `crawl-delay`, пауза между страницами не меньше 1 с. Нужно опциональное разрешение `<all_urls>`, оно запрашивается только для этого режима.
- **Разрешения:** `activeTab`, `scripting`, `downloads`, `webRequest`, `storage`; host — только `127.0.0.1` / `localhost`; `<all_urls>` — опционально. Удалённого кода нет: `eval` и внешние скрипты не используются, это проверяют тесты.

## Формат захвата v1

ZIP (или распакованная папка) с манифестом `capture.json`:

```jsonc
{
  "format": "site-blueprint-capture", "version": 1, "createdAt": "…", "mode": "page" | "site",
  "origin": "https://example.com", "start": "https://example.com/",
  "extension": { "name": "site-blueprint", "version": "2.0.0" }, "userAgent": "…",
  "options": { "api": true, "state": true, "robots": true, "maxPages": 10, "depth": 2, "reload": false },
  "pages": [{ "url": "…", "finalUrl": "…", "slug": "index", "title": "…", "depth": 0, "from": null, "ms": 0,
              "raw": "pages/index.json", "snapshot": "snapshots/index.json", "screenshot": "screenshots/index.png",
              "screenshotInfo": { … }, "state": "state/index.json", "trackers": "trackers/index.json",
              "hydration": "hydration/index.json", "warnings": [] }],
  "api": "api/requests.json", "assets": "assets/index.json", "css": "css/index.json",
  "counts": { "pages": 1, "api": 3, "assets": 40, "assetBytes": 123456, "css": 4 }, "warnings": []
}
```

| Файл | Содержимое |
| --- | --- |
| `pages/<slug>.json` | результат `extractPage()` — тот же формат, что у краулера |
| `snapshots/<slug>.json` | SingleFile-HTML с плейсхолдерами ресурсов |
| `screenshots/<slug>.png` | скриншот всей страницы в CSS-пикселях |
| `state/<slug>.json` | пробы: вкладки/фильтры, аккордеоны, диалоги, hover-меню, `<details>` |
| `trackers/<slug>.json` | URL скриптов и inline-фрагменты (для отчёта о трекерах, в клон не попадают) |
| `hydration/<slug>.json` | состояние фреймворка (`__NEXT_DATA__`, `__NUXT__`, JSON-LD…) и имена ключей storage |
| `api/requests.json` | XHR/fetch-ответы вкладки, уже замаскированные |
| `assets/index.json` + `assets/files/*` | картинки, шрифты, медиа, иконки |
| `css/index.json` + `css/files/*` | тексты таблиц стилей |

**Импорт** (`src/capture/import.mjs`). Из архива ничего не выполняется: JSON парсится, бинарные файлы копируются. Проверяются `format` и `version` (захват новее CLI → понятная ошибка «обнови CLI»), `origin` и URL страниц (только http/https), имена файлов (без zip-slip и абсолютных путей). Действуют лимиты: число записей, размер записи, общий размер (зависит от `--max-upload-mb`). Если архив врёт о размере (zip-бомба), распаковка останавливается. Битый CRC — ошибка. API-ответы маскируются повторно, трекеры сводятся в общий отчёт. Скриншоты режутся на секции и «листы» для LLM. Недостающие ассеты докачиваются, если не задан `--offline`.

## Безопасность `listen`

`site-blueprint listen` принимает данные только от расширения на этой машине:

| Проверка | Ответ при нарушении |
| --- | --- |
| слушает только `127.0.0.1` | — |
| `Host` — `127.0.0.1` / `localhost` (защита от DNS rebinding) | 421 |
| `Origin` — только `chrome-extension://`, `moz-extension://`, `--allow-origin`, либо без Origin (curl) | 403 |
| CORS-preflight с `Access-Control-Allow-Private-Network` только для разрешённых Origin | — |
| обязательный заголовок `X-SB-Client`: из-за него браузер шлёт preflight, который веб-страницы не проходят | 400 |
| `X-SB-Token` при `--token` / `SB_LISTEN_TOKEN` (сравнение за постоянное время) | 401 |
| `Content-Type` — ZIP, тело начинается с сигнатуры ZIP | 415 / 400 |
| размер ≤ `--max-upload-mb` (по `Content-Length` и при чтении потока) | 413 |
| `/capture` — только POST | 405 |

Маршруты: `GET /health`, `POST /capture` → `202` + `Location: /jobs/<id>`, `GET /jobs`, `GET /jobs/<id>` (`queued → running → done | failed | error`). Задачи выполняются строго по одной. Принятые ZIP лежат в `<out>/_incoming` и удаляются после импорта, если не задан `--keep-incoming`. Если порт занят или запрещён (EADDRINUSE / EACCES), выводится понятное сообщение и код выхода 1.

## Мок-API

```text
Playwright page.on('response')  ─┐                          ┌─► project/mocks/data/<id>.json
                                  ├─► ApiSniffer ─► Redactor ─► data/api-mocks/ ─► output/api.mjs ─┼─► project/mocks/registry.ts
extension api/requests.json ─────┘   (фильтр шума,            (index.json:                         ├─► project/lib/mock-api.ts
                                       ключ без cache-busters, записи + отчёт                     ├─► project/app/api/[...route]/route.ts
                                       GraphQL operationName)  о маскировании)                     └─► next.config.mjs rewrites
```

- Мок описывается методом, хостом, путём, query без cache-busters и `operationName` для GraphQL. Поиск (`findMock` в `lib/mock-api.ts`) идёт по оценке: путь и хост должны совпасть; метод тоже, но `HEAD` может ответить GET-моком; для GraphQL важен `operationName`; из оставшихся побеждает мок с наибольшим числом совпавших query-параметров.
- Эндпоинты оригинала вне `/api` (например, `/graphql`) подключаются через `rewrites` на `/api/__mock/<путь>`, внешние API-хосты — через `/api/__mock/ext/<host>/<путь>`. Если мок не найден, ответ — `404` в JSON с подсказкой.
- **Маскирование** (`Redactor`). Заголовки `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`… не сохраняются вовсе. Секретные поля и query-параметры (`token`, `password`, `secret`, `session`, `csrf`…) становятся `[REDACTED]`, JWT — `[REDACTED_JWT]`, `Bearer`/`Basic` — `Bearer [REDACTED]`, похожие на ключи строки (`sk-…`, `ghp_…`, `AKIA…`, `AIza…`) — `[REDACTED_KEY]`, номера карт (проверка Луна) — `[REDACTED_CARD]`. Email, телефоны и имена заменяются стабильными фейками (`user1@example.com`, `+1 555 010-01-00`, `User 1`), чтобы связи в данных сохранились. Адреса, IP, координаты и даты рождения — `[REDACTED]`. Счётчик замен пишется в `data/api-mocks/index.json` и в §7 блюпринта.

## Самопроверка

```text
selfcheck.mjs
 ├─ build.mjs ensureDeps     shared: <out>/package.json "site-blueprint-shared-deps" + один node_modules на все запуски
 │                           local: npm install в project/ · skip: только если next уже находится
 ├─ build.mjs healProject    for i in 1..N (--heal-iterations, 4):
 │     next build ─► parseBuildErrors (webpack и Turbopack → файл, строка, класс: css, import, client,
 │                   nesting, custom-element, syntax, type) ─► ok? → стоп
 │       ├─ детерминированные фиксеры: 'use client', кастомные элементы в JSX, иконки (экспорт/импорт),
 │       │  вложенность DOM, CSS, отвергнутый Lightning CSS (через analyze/cssvars.mjs)
 │       ├─ LLM: ошибка + файл → SEARCH/REPLACE-блоки (parsePatches / applyPatch; пустой SEARCH отклоняется)
 │       ├─ бэкап до первого изменения: verify/heal-backup/<итерация>/<файл>
 │       └─ итерация ничего не изменила → стоп (no progress)
 ├─ server.mjs               next start -p <свободный порт>; остановка всего дерева процессов
 │                           (POSIX — группа процессов, Windows — taskkill /T)
 └─ visual.mjs               скриншоты клона в вьюпортах обхода → pixelmatch (threshold 0.1, учёт сглаживания)
                             по странице и по полосам секций → verify/visual/*-{clone,diff,compare}.png
     ─► VERIFICATION_REPORT.md + verify/selfcheck.json + verify/heal.json; --strict → код выхода 3
```

`site-blueprint heal <папка>` запускает тот же этап без перегенерации `project/`. `site-blueprint verify <папка> --url …` (`src/verify/index.mjs`) сверяет уже запущенный клон: секции сопоставляются по текстовым якорям, проверяются пропавшие тексты, битые картинки, 4xx/5xx, ошибки консоли, горизонтальная прокрутка и шрифты. Отчёт — `verify/report.md` и `report.json`.

## Плагины

Плагин — объект `{ name, hooks: { … } }`, объект или класс с `apply(register)` либо фабрика. Хуки:

| Хук | Тип вызова | Payload |
| --- | --- | --- |
| `beforeStart` | emit | `{ startUrl, opts, outDir }` |
| `beforeRequest` | first | `{ url, method, resourceType }` → `{ abort: true }` / `{ headers }` |
| `afterResponse` | emit | `{ response, url, status, resourceType, page, slug }` |
| `beforeExtract` / `afterExtract` | emit | `{ page, url, slug, view }` / `+ raw` |
| `generateFilename` | waterfall | `(name, { url, kind, category, ext, hint, base })` → имя |
| `onAssetSaved` / `onAssetError` | emit | `{ url, web, file, bytes, category }` / `{ url, error }` |
| `beforeWrite` | waterfall | `(text, { file })` → текст |
| `afterProject` | emit | `{ root, files, site }` |
| `afterFinish` | emit | `{ outDir, site, project, check }` |
| `error` | emit | `{ stage, error }` |

Исключение в плагине пишется в лог как предупреждение и не прерывает конвейер.

## Принципы

- **Один формат данных.** Краулер и расширение пишут одинаковые `data/pages/*.json`. Анализ, генерация и проверка не знают источник.
- **Без обхода защит.** Robots.txt и `crawl-delay` соблюдаются. User-Agent не подделывается и не ротируется, автоматизация не скрывается, капчи и Cloudflare не обходятся. Сайты за логином или проверкой снимает расширение в браузере пользователя: человек сам входит или проходит проверку, а расширение сохраняет то, что он видит. Init-хуки только наблюдают — ничего на странице не блокируют и не подменяют.
- **Приватность.** Cookies и заголовки авторизации не сохраняются. Секреты в моках становятся `[REDACTED…]`, персональные данные — стабильными фейками (`user1@example.com`). Для захватов расширением маскирование выполняется дважды: в расширении и в CLI. Трекеры блокируются и вырезаются из всего, что попадает в клон.
- **Ничего не исполняется из захвата.** Импорт только парсит JSON и копирует файлы с проверкой имён и размеров. Снимки и DOM проходят санитайзер.
- **Кроссплатформенность.** Пути — только через `node:path` и `fileURLToPath`. Имена файлов безопасны для Windows. Внешние команды запускаются без shell (кроме `npm.cmd` на Windows). Процессы останавливаются с учётом Windows. ZIP пишется с UTF-8 именами (флаг 0x0800) и `/`-разделителями.
