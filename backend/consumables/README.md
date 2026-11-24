# Учёт расходников питомника

Склад — отдельный HTTP-сервис со своей базой SQLite. Он учитывает закупки, ручное использование и расход при посадке растений. Администратор видит количество в единицах материала, журнал движений и посадки, которые ожидают списания.

## Запуск двух сервисов

Понадобится Node.js 24.4 или новее со встроенным `node:sqlite`. Откройте два окна PowerShell в каталоге, содержащем папку `backend`. Для примера в обоих окнах задайте одинаковый пароль администратора и одинаковый ключ обмена. Храните файлы рабочих баз вне папки, которую раздаёт HTTP-сервер витрины.

```powershell
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Пароль admin' -AsSecureString)).Password
$env:MATERIAL_SYNC_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Отдельный ключ обмена между сервисами' -AsSecureString)).Password
```

**В первом окне запустите сервис растений.** Если в питомнике уже ведётся учёт, используйте прежние `INVENTORY_DB` и ключ кассы. Обновлённый сервис сам добавит в базу журнал для новых посадок.

```powershell
$env:POS_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Ключ кассы' -AsSecureString)).Password
node backend/server.mjs
```

**Во втором окне запустите склад.** Следующие команды создают отдельную демонстрационную базу с учебной закупкой 100 горшков и 50 л грунта. Общая учебная норма — 1 горшок и 0,5 л на растение. Повторный `seed-demo` учитывает эту закупку однократно.

```powershell
$env:MATERIALS_DB = Join-Path $env:LOCALAPPDATA 'XromGroup\consumables-demo.sqlite'
node backend/consumables/server.mjs seed-demo
node backend/consumables/server.mjs
```

Можно также указать в `MATERIALS_DB` полный путь к готовой демонстрационной базе. Для рабочего склада задайте путь к новой базе и запустите только `node backend/consumables/server.mjs`. Артикулы `pot` и `soil` начнут с нулевого остатка. Зарегистрируйте фактический запас первой приходной операцией и задайте норму посадки через API.

## Проверка на одной посадке

В третьем окне PowerShell войдите в оба сервиса. Каждый выдаёт токен для своего API.

```powershell
$plants = 'http://127.0.0.1:8787/api/admin'
$stock = 'http://127.0.0.1:8788/api/admin'
$json = 'application/json; charset=utf-8'
$password = [System.Net.NetworkCredential]::new('', (Read-Host 'Пароль admin' -AsSecureString)).Password
$credentials = @{ username = 'admin'; password = $password } | ConvertTo-Json
$grower = (Invoke-RestMethod -Method Post -Uri "$plants/login" -ContentType $json -Body $credentials).access_token
$keeper = (Invoke-RestMethod -Method Post -Uri "$stock/login" -ContentType $json -Body $credentials).access_token
$plantHeaders = @{ Authorization = "Bearer $grower" }
$stockHeaders = @{ Authorization = "Bearer $keeper" }
$planting = @{ planting_id = [guid]::NewGuid().ToString(); plant_id = 'lavandula-angustifolia'; location = 'Теплица 1'; quantity = 40 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$plants/plantings" -Headers $plantHeaders -ContentType $json -Body $planting
```

Склад опрашивает сервис растений каждые две секунды. После обработки примера останутся 60 горшков и 30 л грунта. В журнале две строки будут связаны с `planting_id`. Для повтора потерянного запроса используйте сохранённое тело `$planting`.

```powershell
(Invoke-RestMethod "$stock/materials" -Headers $stockHeaders).items | Format-Table name,quantity,unit
(Invoke-RestMethod "$stock/plantings" -Headers $stockHeaders).items
(Invoke-RestMethod "$stock/movements" -Headers $stockHeaders).items | Format-Table kind,operation_id,name,delta,unit,balance_after
```

Зарегистрируйте закупку ещё 20 горшков и 10 л грунта. После этой закупки в примере будет 80 горшков и 40 л. [Пример накладной](examples/purchase.json)

```powershell
$purchase = Get-Content -Raw -Encoding UTF8 backend/consumables/examples/purchase.json
Invoke-RestMethod -Method Post -Uri "$stock/purchases" -Headers $stockHeaders -ContentType $json -Body $purchase
```

## Контракт складского API

Базовый адрес по умолчанию `http://127.0.0.1:8788`. Для административных запросов передайте `Authorization: Bearer <access_token>`, для тела — `Content-Type: application/json`. Сессия администратора действует восемь часов. Остатки содержат артикул, название, единицу, точность и количество.

| Метод и маршрут | Назначение и тело запроса |
|---|---|
| `POST /api/admin/login`, `POST /api/admin/logout` | Вход по `username`, `password` и завершение текущей сессии |
| `GET /api/admin/materials` | Список всех расходников с остатками |
| `POST /api/admin/materials` | Новый артикул с нулевым остатком, например `{"id":"fertilizer","name":"Удобрение","unit":"кг","decimals":3}` |
| `POST /api/admin/purchases` | Приход по закупке. Обязательны `operation_id` и массив `items` с полями `material_id`, `quantity` |
| `POST /api/admin/usage` | Ручное списание, например `{"operation_id":"work-17","items":[{"material_id":"soil","quantity":1.25}]}` |
| `GET /api/admin/movements` | Журнал с количеством изменения, остатком после операции и номером накладной, списания или посадки. Фильтр `?material_id=soil` |
| `PUT /api/admin/recipes` | Установить полную норму на **одно** растение. Поле `plant_id` задаёт индивидуальную норму для артикула, `null` или пропуск поля — общую |
| `GET /api/admin/recipes` | Действующие нормы |
| `GET /api/admin/plantings` | Состояние списания по каждой посадке и причина ожидания. Фильтры `?status=pending` и `?status=applied` |
| `GET /api/admin/sync` | Последний принятый номер события, время успешного обмена и последняя ошибка |
| `GET /health` | Доступность процесса и SQLite |

Задайте размерность при создании материала. `decimals` принимает значения от 0 до 3, по умолчанию 0. Для горшков принимаются целые количества, для грунта — литры с точностью до миллилитра. Количество в документе положительное. Один документ может содержать несколько разных материалов. При недостатке хотя бы одного материала при ручном расходе сервис возвращает `409 insufficient_material` и откатывает весь документ.

При повторной отправке закупки или ручного списания используйте исходный `operation_id` и состав. При первом проведении ответ имеет код `201`, при повторе — `200` и `replayed: true`. Изменение состава под прежним номером того же типа операции даёт `409 operation_conflict`.

## Нормы и автоматическое списание

Пример тела `PUT /api/admin/recipes` задаёт для лаванды 1 горшок и 0,75 л грунта на экземпляр.

```json
{
  "plant_id": "lavandula-angustifolia",
  "items": [
    { "material_id": "pot", "quantity": 1 },
    { "material_id": "soil", "quantity": 0.75 }
  ]
}
```

Сервис растений сохраняет событие одновременно с регистрацией через `POST /api/admin/plantings`. Склад забирает события по внутреннему HTTP API и запоминает позицию в своей базе. После перерыва он продолжает с сохранённого места. Обмен начинается с посадок, зарегистрированных после установки обновления сервиса растений. Изменения стадии, продажи и правки количества относятся к уже учтённым партиям.

Для каждой новой посадки склад берёт индивидуальную норму, действовавшую в момент регистрации, либо общую на тот же момент. Количество каждого материала равно норме, умноженной на исходное число посаженных растений. Если норм ещё не было, посадка ожидает первую подходящую норму. Выбранная версия сохраняется вместе с посадкой.

Списание всех строк и отметка `applied` фиксируются одной SQL-транзакцией. При дефиците в очереди видны `pending`, код `insufficient_material`, артикул, доступное и требуемое количество. До пополнения склада остатки по этой посадке сохраняются целиком. Другие обеспеченные посадки могут проводиться. После закупки или настройки недостающей нормы обработчик повторяет попытку автоматически.

## Конфигурация и SQL

| Переменная | Назначение |
|---|---|
| `MATERIALS_DB` | Складская SQLite. По умолчанию `XromGroup/consumables.sqlite` в каталоге данных пользователя |
| `MATERIALS_HOST`, `MATERIALS_PORT` | Адрес склада, по умолчанию `127.0.0.1` и `8788` |
| `PLANT_SERVICE_URL` | Адрес сервиса растений для склада, по умолчанию `http://127.0.0.1:8787` |
| `MATERIALS_POLL_MS` | Период опроса в миллисекундах, по умолчанию `2000` |
| `MATERIAL_SYNC_TOKEN` | Общий ключ двух процессов для чтения `GET /api/internal/plantings?after=0` на сервисе растений. Задаётся отдельно от административного пароля и ключа кассы |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Логин (по умолчанию `admin`) и пароль администратора склада |

Для сетевого развёртывания используйте HTTPS. Складская база связана с одной базой растений. Таблицы `materials`, `operations` и `movements` содержат каталог, документы и проводки. Количества хранятся целыми тысячными долями единицы. Представления `material_inventory` и `material_history_view` возвращают их в единицах материала. [SQL-схема склада](schema.sql)

```sql
SELECT name AS "Расходник", quantity AS "Остаток", unit AS "Единица"
FROM material_inventory ORDER BY name;
```

Для проверки обоих сервисов выполните `node --test backend/test/inventory.test.mjs backend/test/consumables.test.mjs`.
