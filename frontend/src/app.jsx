import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LayoutDashboard,
  Sprout,
  ClipboardList,
  Boxes,
  BookOpen,
  LogOut,
  PanelLeft,
  ChevronRight,
  CalendarDays,
  RefreshCw,
  Plus,
  ShoppingBasket,
  Minus,
  X,
} from 'lucide-react';
import { api, Brand, Badge, Empty, stages, statuses, careLabels, num, dateTime } from './shared';
import { Modal, PanelHead, PlantTable, SearchBox, TaskCard, PlantIcon } from './components';
import { BatchForm, MaterialForm, StockForm } from './forms';

const pages = [
  ['overview', 'Обзор', LayoutDashboard],
  ['plants', 'Растения', Sprout],
  ['tasks', 'Задачи', ClipboardList],
  ['store', 'Склад', Boxes],
  ['catalog', 'Справочник', BookOpen],
];
const routes = {
  inventory: 'plants/inventory',
  catalog: 'plants/plants',
  tasks: 'tasks/tasks',
  materials: 'store/materials',
  movements: 'store/movements',
  recipes: 'store/recipes',
  jobs: 'store/plantings',
  sync: 'store/sync',
};
const opLabels = { purchase: 'Приход', usage: 'Расход', planting: 'Посадка' };
const fmtDate = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const localDay = (s) => (s ? new Date(s + 'T12:00:00Z') : new Date());
const currentPage = () => pages.find((p) => p[0] === location.hash.slice(1))?.[0] || 'overview';

function useNursery() {
  const [data, setData] = useState({}),
    [errors, setErrors] = useState({}),
    [busy, setBusy] = useState(true);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    setBusy(true);
    const responses = await Promise.allSettled(Object.values(routes).map((path) => api(path)));
    if (sequence.current !== id) return;
    const fresh = {},
      failed = {};
    Object.keys(routes).forEach((key, i) => {
      const r = responses[i];
      if (r.status === 'fulfilled') fresh[key] = r.value;
      else failed[key] = r.reason.message;
    });
    setData((prev) => ({ ...prev, ...fresh }));
    setErrors(failed);
    setBusy(false);
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(() => {
      if (!document.hidden) reload();
    }, 30000);
    return () => {
      ++sequence.current;
      clearInterval(timer);
    };
  }, [reload]);
  return { data, reload, errors, busy };
}
function Overview({ data, nav, open }) {
  const batches = data.inventory?.items || [],
    tasks = data.tasks?.items || [];
  const total = batches.reduce((n, b) => n + b.quantity, 0),
    ready = batches.filter((b) => b.stage === 'ready').reduce((n, b) => n + b.quantity, 0);
  const day = data.tasks?.date;
  const stats = [
    ['Растения в учёте', data.inventory ? num(total) : '—', 'шт.', Sprout, 'green', 'plants'],
    ['Готово к продаже', data.inventory ? num(ready) : '—', 'шт.', ShoppingBasket, 'amber', 'ready'],
    [
      'Открытые задачи',
      data.tasks ? num(tasks.filter((t) => t.status !== 'done').length) : '—',
      '',
      ClipboardList,
      'violet',
      'tasks',
    ],
    ['Виды расходников', data.materials ? num(data.materials.items.length) : '—', '', Boxes, 'blue', 'store'],
  ];
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="hero-date">
            <CalendarDays size={15} />
            {fmtDate.format(localDay(day))}
          </span>
          <h1>Обзор питомника</h1>
          <button className="btn hero-btn" onClick={() => open('plant')}>
            <Plus size={17} />
            Новая посадка
          </button>
        </div>
      </section>
      <div className="metrics">
        {stats.map(([label, n, unit, Icon, color, target]) => (
          <button className="metric" key={label} onClick={() => nav(target)}>
            <span className={'metric-icon ' + color}>
              <Icon size={20} />
            </span>
            <span className="metric-value">
              {n} <small>{unit}</small>
            </span>
            <span className="metric-label">{label}</span>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <PanelHead title="Последние партии" action="Все партии" onAction={() => nav('plants')} />
          <PlantTable
            compact
            items={[...batches]
              .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id)
              .slice(0, 5)}
            select={(b) => open('batch', b)}
          />
        </section>
        <section className="panel">
          <PanelHead title="Задачи команды" action="Все" onAction={() => nav('tasks')} />
          <div className="mini-list">
            {tasks
              .filter((t) => t.status !== 'done')
              .slice(0, 4)
              .map((t) => (
                <button className="mini-task" key={t.id} onClick={() => open('task', t)}>
                  <span className="mini-icon">
                    <ClipboardList size={17} />
                  </span>
                  <span>
                    <strong>{t.title}</strong>
                    <small>
                      {t.assignee_name} · {t.location}
                    </small>
                  </span>
                </button>
              ))}
            {!tasks.some((t) => t.status !== 'done') && <Empty>Открытых задач нет.</Empty>}
          </div>
        </section>
      </div>
    </>
  );
}
function Heading({ title, children, sub }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}
function Plants({ data, open, stage, setStage }) {
  const [q, setQ] = useState('');
  const items = data.inventory?.items || [];
  const filtered = items.filter(
    (b) =>
      (!stage || b.stage === stage) &&
      (b.name + ' ' + b.location + ' ' + b.id).toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <>
      <Heading title="Учёт растений" sub={'Всего партий: ' + num(items.length)}>
        <button className="btn primary" onClick={() => open('plant')}>
          <Plus size={17} />
          Новая посадка
        </button>
      </Heading>
      <section className="panel">
        <div className="toolbar">
          <SearchBox value={q} onChange={setQ} placeholder="Найти растение или место" />
          <select aria-label="Стадия роста" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Все стадии</option>
            {Object.entries(stages).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <PlantTable items={filtered} select={(b) => open('batch', b)} />
      </section>
    </>
  );
}
function Tasks({ data, open }) {
  const [worker, setWorker] = useState('');
  const all = data.tasks?.items || [],
    list = all.filter((t) => !worker || t.assignee_id === Number(worker));
  return (
    <>
      <Heading title="Задачи команды" sub={fmtDate.format(localDay(data.tasks?.date))}>
        <select value={worker} aria-label="Исполнитель" onChange={(e) => setWorker(e.target.value)}>
          <option value="">Все сотрудники</option>
          {data.tasks?.employees?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Heading>
      <div className="kanban">
        {Object.entries(statuses).map(([code, label]) => (
          <section className={'lane ' + code} key={code}>
            <h2>
              <span className={'dot ' + code} />
              {label}
              <i>{list.filter((t) => t.status === code).length}</i>
            </h2>
            {list
              .filter((t) => t.status === code)
              .map((t) => (
                <TaskCard task={t} key={t.id} onClick={(v) => open('task', v)} />
              ))}
            {!list.some((t) => t.status === code) && <Empty>Задач нет.</Empty>}
          </section>
        ))}
      </div>
    </>
  );
}
function SimpleTable({ headers, rows }) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, ...cells]) => (
            <tr key={id}>
              {cells.map((v, i) => (
                <td key={i}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty>Записей пока нет.</Empty>
  );
}
function Store({ data, open }) {
  const [tab, setTab] = useState('materials');
  const materials = data.materials?.items || [],
    plants = data.catalog?.items || [];
  const mat = (id) => materials.find((m) => m.id === id),
    plant = (id) => plants.find((p) => p.id === id)?.name || id;
  const tabs = {
    materials: 'Остатки',
    movements: 'Движения',
    recipes: 'Нормы посадки',
    jobs: 'Списания по посадкам',
  };
  const rows = {
    materials: materials.map((m) => [m.id, <strong>{m.name}</strong>, m.id, num(m.quantity), m.unit]),
    movements: (data.movements?.items || []).map((r) => [
      r.operation_no + '-' + r.material_id,
      dateTime(r.recorded_at),
      opLabels[r.kind],
      r.name,
      (r.delta > 0 ? '+' : '') + num(r.delta) + ' ' + r.unit,
      num(r.balance_after) + ' ' + r.unit,
      r.operation_id,
    ]),
    recipes: (data.recipes?.items || []).map((r) => [
      r.id,
      r.plant_id ? plant(r.plant_id) : 'Общая норма',
      r.items
        .map(
          (i) =>
            num(i.quantity) +
            ' ' +
            (mat(i.material_id)?.unit || '') +
            ' · ' +
            (mat(i.material_id)?.name || i.material_id),
        )
        .join(', '),
    ]),
    jobs: (data.jobs?.items || []).map((j) => [
      j.seq,
      j.planting_id,
      plant(j.plant_id),
      num(j.quantity),
      j.status === 'applied' ? 'Списано' : 'Ожидает',
      j.problem?.code === 'missing_recipe'
        ? 'Нужна норма'
        : j.problem?.material_id
          ? (j.problem.code === 'quantity_limit'
              ? 'Превышен лимит количества: '
              : 'Недостаточно материала: ') + (mat(j.problem.material_id)?.name || j.problem.material_id)
          : '—',
    ]),
  };
  const head = {
    materials: ['Материал', 'Артикул', 'Остаток', 'Ед.'],
    movements: ['Время', 'Операция', 'Материал', 'Изменение', 'После операции', 'Документ'],
    recipes: ['Растение', 'Расход на экземпляр'],
    jobs: ['Посадка', 'Растение', 'Количество', 'Состояние', 'Причина ожидания'],
  };
  return (
    <>
      <Heading title="Склад расходников">
        <div className="button-row">
          <button className="btn" onClick={() => open('usage')}>
            <Minus size={16} />
            Списание
          </button>
          <button className="btn primary" onClick={() => open('purchases')}>
            <Plus size={16} />
            Приход
          </button>
        </div>
      </Heading>
      <div className="tabs">
        {Object.entries(tabs).map(([k, v]) => (
          <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {v}
          </button>
        ))}
      </div>
      <section className="panel">
        <PanelHead
          title={tabs[tab]}
          action={tab === 'materials' ? 'Добавить материал' : tab === 'recipes' ? 'Настроить норму' : null}
          onAction={() => open(tab === 'materials' ? 'material' : 'recipe')}
        />
        <SimpleTable headers={head[tab]} rows={rows[tab]} />
      </section>
      {tab === 'jobs' && (
        <p className="sync-info">
          Последняя синхронизация: {dateTime(data.sync?.last_success)}
          {data.sync?.last_error && ' · ' + data.sync.last_error}
        </p>
      )}
    </>
  );
}
function Catalog({ data, open }) {
  const [q, search] = useState('');
  const plants = (data.catalog?.items || []).filter((p) =>
    (p.name + ' ' + (p.care?.scientific_name || '')).toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <>
      <Heading title="Справочник растений">
        <SearchBox value={q} onChange={search} placeholder="Найти растение" />
      </Heading>
      <div className="catalog">
        {plants.map((p) => (
          <button key={p.id} className="catalog-card" onClick={() => open('care', p)}>
            <PlantIcon id={p.id} />
            <strong>{p.name}</strong>
            <small>{p.care?.scientific_name || 'Карточка ухода не заполнена'}</small>
            {p.care && <span>{p.care.category}</span>}
          </button>
        ))}
      </div>
      {!plants.length && <Empty>Растения не найдены.</Empty>}
    </>
  );
}
function Details({ type, item }) {
  if (type === 'task')
    return (
      <div className="details">
        <Badge value={item.status} labels={statuses} />
        <h3>{item.title}</h3>
        <p>
          {item.plant_name} · {item.quantity} шт.
        </p>
        <dl>
          <dt>Исполнитель</dt>
          <dd>{item.assignee_name}</dd>
          <dt>Место</dt>
          <dd>{item.location}</dd>
          <dt>Срок</dt>
          <dd>{item.due_on.split('-').reverse().join('.')}</dd>
          {item.completed_at && (
            <>
              <dt>Выполнено</dt>
              <dd>{dateTime(item.completed_at)}</dd>
            </>
          )}
        </dl>
        <h4>Что сделать</h4>
        <p>{item.instructions}</p>
        <Care care={item.care} />
      </div>
    );
  return (
    <div className="details">
      <PlantIcon id={item.id} />
      <h3>{item.name}</h3>
      <p>{item.care?.scientific_name}</p>
      {item.care ? (
        <>
          <Care care={item.care} />
          <h4>Зимостойкость</h4>
          <p>
            Зона {item.care.hardiness.zone} · до {item.care.hardiness.min_temperature_c} °C.{' '}
            {item.care.hardiness.notes}
          </p>
          <h4>Высота</h4>
          <p>
            {item.care.height.min_cm}–{item.care.height.max_cm} см
          </p>
        </>
      ) : (
        <Empty>Карточка ухода пока не заполнена.</Empty>
      )}
    </div>
  );
}
function Care({ care }) {
  return Object.entries(careLabels)
    .filter(([k]) => care?.[k])
    .map(([k, label]) => (
      <React.Fragment key={k}>
        <h4>{label}</h4>
        <p>{care[k]}</p>
      </React.Fragment>
    ));
}
const formTitles = {
  plant: 'Новая посадка',
  batch: 'Партия растений',
  task: 'Задача сотрудника',
  care: 'Карточка растения',
  material: 'Новый материал',
  usage: 'Списание материалов',
  purchases: 'Приход материалов',
  recipe: 'Норма посадки',
};
function App() {
  const [page, setPage] = useState(currentPage),
    [stage, setStage] = useState(''),
    [menu, setMenu] = useState(false),
    [dialog, setDialog] = useState(null),
    [notice, setNotice] = useState(''),
    [user, setUser] = useState(''),
    [signing, setSigning] = useState(false);
  const { data, reload, errors, busy } = useNursery();
  useEffect(() => {
    api('session')
      .then((s) => setUser(s.username))
      .catch((e) => setNotice(e.message));
    const hash = () => {
      setPage(currentPage());
      setMenu(false);
      setDialog(null);
    };
    window.addEventListener('hashchange', hash);
    return () => window.removeEventListener('hashchange', hash);
  }, []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const nav = (id) => {
    setMenu(false);
    setStage(id === 'ready' ? 'ready' : '');
    location.hash = id === 'ready' ? 'plants' : id;
  };
  const open = (type, item) => setDialog({ type, item }),
    saved = (message) => {
      setDialog(null);
      setNotice(message);
      reload();
    };
  const { type, item } = dialog || {};
  const currentName = pages.find((p) => p[0] === page)?.[1];
  async function logout() {
    setSigning(true);
    try {
      await api('logout', { method: 'POST' });
      location.replace('/');
    } catch (e) {
      setNotice(e.message);
      setSigning(false);
    }
  }
  return (
    <div className="app">
      {menu && <button className="shade" aria-label="Закрыть меню" onClick={() => setMenu(false)} />}
      <aside id="nursery-sidebar" className={menu ? 'side open' : 'side'}>
        <Brand />
        <nav aria-label="Основная навигация">
          {pages.map(([key, label, Icon]) => (
            <a
              key={key}
              className={page === key ? 'active' : ''}
              aria-current={page === key ? 'page' : undefined}
              href={'#' + key}
              onClick={() => {
                setMenu(false);
                setStage('');
              }}
            >
              <Icon size={19} />
              {label}
            </a>
          ))}
        </nav>
        <div className="account">
          <span className="avatar">{(user || 'А')[0].toUpperCase()}</span>
          <span>
            <b>Администратор</b>
            <small>{user}</small>
          </span>
          <button className="iconbtn" disabled={signing} onClick={logout} aria-label="Выйти" title="Выйти">
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="top">
          <div>
            <button
              className="iconbtn menu-btn"
              aria-label="Меню"
              aria-expanded={menu}
              aria-controls="nursery-sidebar"
              onClick={() => setMenu(!menu)}
            >
              <PanelLeft size={20} />
            </button>
            <span>Питомник</span>
            <ChevronRight size={14} />
            <b>{currentName}</b>
          </div>
          <button className="refresh" onClick={reload} disabled={busy}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
            {busy ? 'Обновление' : 'Обновить'}
          </button>
        </header>
        <main className="main">
          {Object.keys(errors).length > 0 && (
            <p className="error" role="alert">
              {[...new Set(Object.values(errors))].join(' ')} Повторите обновление.
            </p>
          )}
          {page === 'overview' && <Overview {...{ data, nav, open }} />}
          {page === 'plants' && <Plants {...{ data, open, stage, setStage }} />}
          {page === 'tasks' && <Tasks {...{ data, open }} />}
          {page === 'store' && <Store {...{ data, open }} />}
          {page === 'catalog' && <Catalog {...{ data, open }} />}
        </main>
      </div>
      {notice && (
        <div role="status" className="toast">
          {notice}
          <button className="iconbtn" onClick={() => setNotice('')} aria-label="Скрыть уведомление">
            <X size={15} />
          </button>
        </div>
      )}
      {dialog && (
        <Modal title={formTitles[type]} close={() => setDialog(null)}>
          {['plant', 'batch'].includes(type) ? (
            <BatchForm batch={item} plants={data.catalog?.items || []} saved={saved} />
          ) : type === 'material' ? (
            <MaterialForm saved={saved} />
          ) : ['purchases', 'usage', 'recipe'].includes(type) ? (
            <StockForm
              type={type}
              materials={data.materials?.items || []}
              plants={data.catalog?.items || []}
              recipes={data.recipes?.items || []}
              saved={saved}
            />
          ) : (
            <Details type={type} item={item} />
          )}
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
