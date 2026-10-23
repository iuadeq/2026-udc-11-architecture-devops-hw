- Інструмент і модель: Claude Code, Claude Opus 4.6
- Дата: 2026-10-23
- Що бачила сесія: тимчасова тека `../ws11-b-docs/` з `app/README.md` та `app/docs/`
- Промпт (дослівно):

  > Намалюй архітектуру цієї системи як C4-діаграми в Mermaid:
  > рівень System Context і рівень Container.
  > Відповідь дай повністю в чаті; файлів не створюй і уточнювальних питань не став —
  > припущення називай явно.

---

## Припущення

1. Документація описує продакшн-середовище — PostgreSQL як основну базу даних.
2. Екран поштомата — це окремий клієнт, який звертається до API по HTTP.
3. Служба доставки використовує сканер, що також надсилає HTTP-запити до API.
4. SMS-провайдер — зовнішній сервіс, до якого worker звертається по HTTP API.
5. Персонал працює з адмінкою через HTTP API (ендпоінт `/admin/parcels`).
6. Моніторинг опитує `/health` — це може бути зовнішня система або внутрішній інструмент.

## Рівень 1 — System Context

```mermaid
flowchart TB
    resident["Мешканець\n(отримує SMS, забирає посилку)"]
    delivery["Служба доставки\n(реєструє посилки сканером)"]
    staff["Персонал\n(переглядає список посилок)"]

    system["Поштомат громади\n(Сервіс управління посилками)"]

    sms_ext["SMS-провайдер\n(зовнішній сервіс)"]
    monitoring["Система моніторингу\n(перевіряє /health)"]

    delivery -->|"Реєструє посилку\n(HTTP POST)"| system
    resident -->|"Вводить код на екрані\n(HTTP POST)"| system
    staff -->|"Переглядає посилки\n(HTTP GET)"| system
    system -->|"Надсилає SMS з кодом\n(HTTP API)"| sms_ext
    sms_ext -->|"SMS з кодом отримання"| resident
    monitoring -->|"GET /health"| system
```

## Рівень 2 — Container

```mermaid
flowchart TB
    resident["Мешканець"]
    delivery["Служба доставки\n(сканер)"]
    staff["Персонал"]
    sms_ext["SMS-провайдер\n(sms.example.net)"]
    monitoring["Система моніторингу"]

    subgraph system ["Поштомат громади"]
        api["API\n(Node.js HTTP-сервер)\nsrc/server.js"]
        worker["Worker\n(фоновий процес)\nsrc/worker.js"]
        nightly["Нічна задача\nbin/expire-parcels.js\n(cron)"]
        db[("PostgreSQL\n(на тій самій VM)")]
    end

    delivery -->|"POST /parcels\n(реєстрація посилки)"| api
    resident -->|"POST /pickup\n(введення коду)"| api
    staff -->|"GET /admin/parcels"| api
    monitoring -->|"GET /health"| api

    api -->|"Читає і пише\n(SQL)"| db
    worker -->|"Читає нерозіслані\n(SQL, кожні 30 с)"| db
    worker -->|"Оновлює notifiedAt\n(SQL)"| db
    worker -->|"Надсилає SMS\n(HTTP POST)"| sms_ext

    nightly -->|"Позначає прострочені\nяк повернені (SQL)"| db
```

## Короткий опис потоку

1. **Реєстрація:** служба доставки сканує посилку → `POST /parcels` → API генерує 6-значний код і зберігає в PostgreSQL.
2. **Сповіщення:** Worker кожні 30 секунд перевіряє базу на нові посилки без сповіщення → надсилає SMS з кодом через SMS-провайдера → оновлює `notifiedAt`.
3. **Отримання:** мешканець вводить код на екрані поштомата → `POST /pickup` → API знаходить посилку за кодом і позначає як видану.
4. **Закінчення терміну:** щоночі `expire-parcels.js` позначає посилки старші за 72 години як повернені відправнику.
5. **Адмінка:** персонал дивиться список через `GET /admin/parcels` (номери телефонів маскуються, коди не показуються).
