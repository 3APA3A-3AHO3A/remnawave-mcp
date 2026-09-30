# remnawave-mcp

MCP-сервер для панели [Remnawave](https://github.com/remnawave) **3.x**. Через него Claude Desktop (а также Cursor, Windsurf и другие MCP-клиенты) может смотреть вашу панель: пользователей, ноды, трафик, устройства, подключения, GeoCheck — обычными вопросами в чате.

**Главное:**

- **Только чтение по умолчанию.** Ничего в панели не меняется, пока вы явно не включите запись.
- **Всегда под вашу версию панели.** Инструменты не написаны руками, а собираются из официального пакета [`@remnawave/backend-contract`](https://www.npmjs.com/package/@remnawave/backend-contract). Обновили панель → подняли версию пакета → пересобрали.
- **Секреты недоступны никогда:** вход в панель, passkey, SECRET_KEY нод, API-токены.
- **Удобные команды сверху:** `find_user` (по Telegram ID, email, username, shortUuid, ID, тегу), `geocheck_node`, `node_connections`, `user_connections` — сами запускают задачу на ноде и ждут результат.

Проверено на Remnawave **3.4.4**.

---

## Установка (Windows)

Нужны [Node.js](https://nodejs.org) 22+ и Git.

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

После установки перезапустите PowerShell.

```powershell
cd C:\Tools
git clone https://github.com/3APA3A-3AHO3A/remnawave-mcp.git
cd remnawave-mcp
npm ci
npm run build
npm run list-tools
```

Последняя строка должна быть вида `81 API tools + 4 extra (contract 3.4.4)`.

На macOS / Linux — те же команды, путь любой.

## API-токен в панели

**Настройки → API-токены → Создать.** Выдайте только права `read`:

users, nodes, hosts, hwid, connections, bandwidth-stats, system, subscriptions, subscription-request-history, internal-squads, external-squads, config-profiles, node-plugins (по желанию — остальные разделы тоже на `read`).

Не выдавайте `write`, `*`, а также api-tokens, passkeys, auth, keygen.

> Права в Remnawave делятся на «чтение/запись», а не на GET/POST. Поэтому GeoCheck, запросы подключений и поиск пользователя работают с правами `read`, хотя это POST-запросы.

## Подключение к Claude Desktop

**Claude → Настройки → Разработчик → Edit Config.** Полностью закройте Claude (трей → Выход), в открывшемся `claude_desktop_config.json` добавьте в начало, сразу после первой `{`:

```json
  "mcpServers": {
    "remnawave": {
      "command": "node",
      "args": ["C:\\Tools\\remnawave-mcp\\dist\\index.js"],
      "env": {
        "REMNAWAVE_BASE_URL": "https://panel.example.com",
        "REMNAWAVE_API_TOKEN": "ВАШ_ТОКЕН"
      }
    }
  },
```

- В пути обратные слэши двойные: `\\`.
- Запятая после блока обязательна, если в файле есть другие настройки.
- Несколько панелей — несколько блоков с разными именами (`remnawave-main`, `remnawave-2` …).

Запустите Claude. В **Настройки → Разработчик** сервер должен быть в статусе **running**. Проверка — спросите: «Сколько пользователей онлайн в панели?»

Пример целиком: [`examples/claude_desktop_config.example.json`](examples/claude_desktop_config.example.json).

## Настройки (переменные окружения)

| Переменная | Обязательна | Что делает |
|---|---|---|
| `REMNAWAVE_BASE_URL` | да | Адрес панели: `https://panel.example.com` (без `/api`) |
| `REMNAWAVE_API_TOKEN` | да | API-токен |
| `REMNAWAVE_READONLY` | нет | `true` по умолчанию. `false` — открыть команды записи (нужен и токен с `write`) |
| `REMNAWAVE_API_KEY` | нет | Заголовок `X-Api-Key` — панель за Caddy с секретным путём |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | нет | Панель за Cloudflare Access |
| `REMNAWAVE_TOOLS_EXCLUDE` | нет | Скрыть инструменты (через запятую) |
| `REMNAWAVE_TOOLS_INCLUDE` | нет | Оставить только эти инструменты |
| `REMNAWAVE_MAX_RESPONSE_CHARS` | нет | Обрезка длинных ответов, по умолчанию 60000 |
| `REMNAWAVE_TIMEOUT_MS` | нет | Таймаут запроса, по умолчанию 30000 |

## Что можно спросить

- «Сколько активных и онлайн пользователей?»
- «Найди клиента с Telegram ID 123456789, покажи устройства и срок подписки»
- «Какие ноды офлайн?» / «Трафик по нодам за прошлую неделю»
- «Сделай GeoCheck ноды NL-1»
- «Кто сейчас на ноде DE-1 и с каких IP?»
- «Топ пользователей по количеству устройств» / «Отчёт по торрентам за сутки»

GeoCheck и запросы подключений немного нагружают ноду — на нодах с лимитом трафика не злоупотребляйте.

## Если не работает

| Симптом | Что делать |
|---|---|
| Статус **failed** в «Разработчике» | Проверьте JSON конфига (запятые, скобки, `\\` в пути); выполните `npm run build` |
| `Remnawave API 401` | Токен истёк или удалён — создайте новый |
| `Remnawave API 403` | Токену не хватает `read` на раздел — пересоздайте с нужными правами |
| `fetch failed` / `ENOTFOUND` / таймаут | Панель недоступна или неверный `REMNAWAVE_BASE_URL` |
| Инструменты не появились | Полностью перезапустите Claude (трей → Выход) |

Логи (Windows): `%APPDATA%\Claude\logs\mcp-server-<имя>.log`

```powershell
Get-Content "$env:APPDATA\Claude\logs\mcp-server-remnawave.log" -Tail 30
```

Проверить конфиг:

```powershell
Get-Content "$env:APPDATA\Claude\claude_desktop_config.json" -Raw | ConvertFrom-Json | Select-Object -ExpandProperty mcpServers | Format-List
```

## Обновление

Новая версия этого репозитория:

```powershell
cd C:\Tools\remnawave-mcp
git pull
npm ci
npm run build
```

Панель обновилась, а репозиторий ещё нет — поставьте контракт под свою версию:

```powershell
npm i @remnawave/backend-contract@<версия_панели> --save-exact
npm run build
```

После любого обновления — полностью перезапустите Claude.

## Как это устроено

В пакете `@remnawave/backend-contract` каждая ручка API описана «командой»: адрес, метод, схемы параметров и пометка чтение/запись. Сервер при запуске проходит по всем командам и превращает каждую в MCP-инструмент, проверяя аргументы теми же схемами, что и панель. Поэтому код почти не зависит от версии Remnawave.

```
src/
  index.ts     — запуск MCP-сервера, выбор инструментов, вызовы
  registry.ts  — сборка инструментов из контракта, список запрещённых
  extras.ts    — удобные инструменты (find_user, geocheck_node, …)
  client.ts    — HTTP-запросы к панели
  config.ts    — переменные окружения
```

## Безопасность

- Токен хранится только в конфиге вашего MCP-клиента, в репозиторий не попадает.
- Данные клиентов (Telegram ID, email, IP) при запросах проходят через ИИ-ассистента — учитывайте это.
- Используйте отдельный токен только на чтение, чтобы его можно было отозвать, не трогая боты и мониторинг.

## Благодарности

Идея — [TrackLine/mcp-remnawave](https://github.com/TrackLine/mcp-remnawave) (под Remnawave 2.x).

## Лицензия

[MIT](LICENSE)
