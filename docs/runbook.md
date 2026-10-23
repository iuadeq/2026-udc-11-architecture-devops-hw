# Runbook: ApiLatencyP95High / Api5xxRateHigh

- **Алерт(и):**
  - `ApiLatencyP95High` — p95 часу відповіді API > 2000 мс протягом 3 хв (page + дзвінок)
  - `Api5xxRateHigh` — частка 5xx > 5 % протягом 3 хв (page + дзвінок)
- **Що це означає для користувачів:** мешканці не можуть забрати посилки — екран поштомата показує «Сервіс зайнятий, спробуйте пізніше»; сканери служби доставки можуть не зареєструвати нові посилки.
- **Скільки є часу:** кожна хвилина — це мешканці біля поштоматів, які не можуть отримати посилку. У піковий час (після обіду, 13:00–16:00) вплив найбільший. Якщо не вирішено за 15 хвилин — ескалюйте.

## Перші 5 хвилин

1. Перевірте, чи був деплой сьогодні:
   ```bash
   ssh poshtomat-prod-1 'grep "$(date -I)" /opt/poshtomat/deploys.log'
   ```
   Якщо деплой був за останню годину — це головний підозрюваний.

2. Перевірте `/health`:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://poshtomat-prod-1:8080/health
   ```
   `200` — процес живий (але може обслуговувати запити погано); інший код або тайм-аут — контейнер мертвий.

3. Подивіться останні помилки API:
   ```bash
   ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml logs api --tail=50 --no-log-prefix'
   ```
   Шукайте `"level":"error"` і текст помилки — він підкаже напрямок далі.

## Діагностика

| Питання | Команда | Як читати результат |
|---|---|---|
| Був деплой? | `ssh poshtomat-prod-1 'tail -5 /opt/poshtomat/deploys.log'` | Якщо деплой за останню годину — ймовірна причина, розглядайте відкат |
| Пул БД вичерпано? | `ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml logs api --tail=200 --no-log-prefix \| grep -c "pool wait timeout"'` | > 0 — пул з'єднань перевантажено; це головний симптом інциденту 2026-10-14 |
| Які саме помилки? | `ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml logs api --tail=200 --no-log-prefix \| grep "level.*error" \| grep -o "error\":\"[^\"]*" \| sort \| uniq -c \| sort -rn'` | `pool wait timeout` → пул; `Cannot read properties` → баг у коді; інше → дивіться далі |
| БД жива? | `ssh poshtomat-prod-1 'sudo -u postgres psql -c "SELECT 1"'` | Відповідь `1` — БД працює; помилка підключення — БД лежить, див. «Що робити» |
| Зараз бекап (02:00–02:30)? | Перевірте час: `TZ=Europe/Kyiv date '+%H:%M'` | Якщо 02:00–02:30 — БД у режимі лише читання, запис блокується; зачекайте до 02:30 |
| Контейнери живі? | `ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml ps'` | `api` має бути `Up (healthy)`; `Restarting` або `Exit` — проблема |
| Змінні оточення збігаються з кодом? | `ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml exec api env \| sort'` | Порівняйте з `app/src/config.js`; інцидент 14.10 стався через перейменування `DB_POOL_MAX` → `DB_POOL_SIZE` |

## Як підтвердити причину

Два факти відрізняють «перейменування змінної → пул зменшився» від інших проблем:

1. **`db_pool_in_use` у метриках раптово впав** (наприклад, з 12 до 4) одночасно з деплоєм:
   ```bash
   ssh poshtomat-prod-1 'grep "$(date -I)" /opt/poshtomat/metrics/*.csv | tail -10'
   ```
2. **Compose задає змінну, якої код не читає:**
   ```bash
   ssh poshtomat-prod-1 'grep -E "DB_POOL_(MAX|SIZE)" /opt/poshtomat/deploy/compose.yaml'
   ```
   Код (`app/src/config.js:9`) читає `DB_POOL_MAX`; якщо в compose стоїть `DB_POOL_SIZE` — це причина.

## Що робити

| Ситуація | Дія | Команда | Ризик / що перевірити після |
|---|---|---|---|
| Деплой за останню годину | Відкат на попередню версію | `ssh poshtomat-prod-1 'cd /opt/poshtomat && git stash && git checkout <попередній-тег> -- deploy/ && docker compose -f deploy/compose.yaml up -d --force-recreate'` | Перевірити `/health`, p95 < 500 мс за 2–3 хв |
| Перейменовано змінну | Повернути правильну назву в compose | `ssh poshtomat-prod-1 'sed -i "s/DB_POOL_SIZE/DB_POOL_MAX/" /opt/poshtomat/deploy/compose.yaml && docker compose -f /opt/poshtomat/deploy/compose.yaml up -d --force-recreate api'` | `docker compose exec api env \| grep DB_POOL` — має бути `DB_POOL_MAX=20` |
| БД не відповідає | Перезапустити PostgreSQL | `ssh poshtomat-prod-1 'sudo systemctl restart postgresql'` | `sudo -u postgres psql -c "SELECT 1"` → OK; потім `/health` → 200 |
| Вікно бекапу (02:00–02:30) | Зачекати завершення бекапу | Нічого не робити | Після 02:30 записи відновляться; `/health` → 200 |
| Контейнер перезавантажується | Перевірити логи і перезапустити | `ssh poshtomat-prod-1 'docker compose -f /opt/poshtomat/deploy/compose.yaml logs api --tail=30 && docker compose restart api'` | Стан `healthy` протягом 1 хв |

## Коли ескалювати і кого кликати

- Не вирішено за **15 хвилин** → повідомити #poshtomat-oncall і poshtomat-team@example.org
- Підозра на **пошкодження бази** → кликати обох розробників (Андрій + Олена)
- Підозра на **витік персональних даних** → повідомити dpo@example.org протягом 24 годин

## Як переконатися, що все гаразд

- `curl -s http://poshtomat-prod-1:8080/health` повертає `{"status":"ok","version":"..."}` зі статусом 200
- p95 нижче 500 мс протягом 5 хвилин після дії
- Error rate нижче 1 % протягом 5 хвилин
- Алерти `ApiLatencyP95High` і `Api5xxRateHigh` автоматично закриваються (resolved)
- Перевірити видачу посилки: ввести код на екрані поштомата — має працювати
