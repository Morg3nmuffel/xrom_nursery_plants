import React, { useState, useEffect } from 'react';
import { Plus, X } from 'lucide-react';
import { api, stages, dateTime, num } from './shared';
import { useSubmit, FormFoot } from './components';

const eventNames = {
  intake: 'Поступление',
  planting: 'Посадка',
  edit: 'Изменение',
  growth: 'Переход стадии',
  sale: 'Продажа',
};
export function BatchForm({ batch, plants, saved }) {
  const [key] = useState(() => crypto.randomUUID()),
    [history, setHistory] = useState(null),
    [histError, herr] = useState('');
  useEffect(() => {
    if (!batch) return;
    let active = true;
    api('plants/inventory/' + batch.id + '/history')
      .then((x) => active && setHistory(x.items))
      .catch((e) => active && herr(e.message));
    return () => {
      active = false;
    };
  }, [batch]);
  const { submit, error, busy } = useSubmit(async (f) => {
    const values = {
      location: f.get('location').trim(),
      stage: f.get('stage'),
      quantity: Number(f.get('quantity')),
    };
    if (batch)
      await api('plants/inventory/' + batch.id, {
        method: 'PATCH',
        body: { ...values, version: batch.version },
      });
    else
      await api('plants/plantings', {
        method: 'POST',
        body: { ...values, planting_id: key, plant_id: f.get('plant') },
      });
    saved(batch ? 'Партия обновлена.' : 'Посадка зарегистрирована.');
  });
  return (
    <form onSubmit={submit} className="edit-form">
      {batch ? (
        <div className="detail-intro">
          <strong>{batch.name}</strong>
          <small>Партия №{batch.id}</small>
        </div>
      ) : (
        <label>
          Растение
          <select required name="plant" defaultValue="">
            <option value="" disabled>
              Выберите растение
            </option>
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Место посадки
        <input
          name="location"
          required
          maxLength={160}
          defaultValue={batch?.location}
          placeholder="Теплица, ряд или площадка"
        />
      </label>
      <div className="form-pair">
        <label>
          Стадия
          <select name="stage" defaultValue={batch?.stage || 'sowing'}>
            {Object.entries(stages)
              .filter(([k]) => batch || k !== 'ready')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </label>
        <label>
          Количество, шт.
          <input
            type="number"
            name="quantity"
            min={batch ? 0 : 1}
            max="2147483647"
            step="1"
            required
            defaultValue={batch?.quantity}
          />
        </label>
      </div>
      {batch && (
        <details>
          <summary>История партии</summary>
          {histError && <p>{histError}</p>}
          {(history || []).map((h) => (
            <p className="journal-line" key={h.id}>
              <b>{eventNames[h.kind] || h.kind}</b> · {dateTime(h.recorded_at)}
              <small>
                {stages[h.stage_after]} · {num(h.quantity_after)} шт. · {h.location_after}
              </small>
            </p>
          ))}
        </details>
      )}
      <FormFoot {...{ busy, error }} label={batch ? 'Сохранить изменения' : 'Зарегистрировать посадку'} />
    </form>
  );
}
export function MaterialForm({ saved }) {
  const { submit, error, busy } = useSubmit(async (f) => {
    await api('store/materials', {
      method: 'POST',
      body: {
        id: f.get('id').trim(),
        name: f.get('name').trim(),
        unit: f.get('unit').trim(),
        decimals: Number(f.get('decimals')),
      },
    });
    saved('Материал добавлен.');
  });
  return (
    <form className="edit-form" onSubmit={submit}>
      <label>
        Название
        <input required name="name" maxLength={160} />
      </label>
      <label>
        Артикул
        <input required name="id" maxLength={160} />
      </label>
      <div className="form-pair">
        <label>
          Единица измерения
          <input required name="unit" placeholder="шт, л или кг" maxLength={32} />
        </label>
        <label>
          Знаков после запятой
          <select name="decimals">
            {[0, 1, 2, 3].map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </label>
      </div>
      <FormFoot {...{ busy, error }} />
    </form>
  );
}
export function StockForm({ type, materials, plants, recipes, saved }) {
  const recipe = type === 'recipe',
    [key] = useState(() => crypto.randomUUID()),
    [scope, setScope] = useState('');
  const empty = () => ({ id: crypto.randomUUID(), material_id: materials[0]?.id || '', quantity: '' });
  const fromScope = (s) =>
    (recipes.find((r) => (r.plant_id || '') === s)?.items || []).map((r) => ({
      ...r,
      id: crypto.randomUUID(),
    }));
  const [lines, setLines] = useState(() => {
    const existing = recipe ? fromScope('') : [];
    return existing.length ? existing : [empty()];
  });
  const change = (id, field, value) =>
    setLines((old) => old.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  const { submit, error, busy } = useSubmit(async () => {
    const items = lines.map((r) => ({ material_id: r.material_id, quantity: Number(r.quantity) }));
    if (new Set(items.map((i) => i.material_id)).size !== items.length)
      throw new Error('Объедините одинаковые материалы в одну строку.');
    await api('store/' + (recipe ? 'recipes' : type), {
      method: recipe ? 'PUT' : 'POST',
      body: recipe ? { plant_id: scope || null, items } : { operation_id: key, items },
    });
    saved(
      recipe ? 'Норма посадки сохранена.' : type === 'purchases' ? 'Приход проведён.' : 'Списание проведено.',
    );
  });
  return (
    <form className="edit-form" onSubmit={submit}>
      {recipe && (
        <label>
          Норма на одно растение
          <select
            value={scope}
            onChange={(e) => {
              const s = e.target.value;
              setScope(s);
              const old = fromScope(s);
              setLines(old.length ? old : [empty()]);
            }}
          >
            <option value="">Общая для питомника</option>
            {plants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {lines.map((r, i) => {
        const m = materials.find((m) => m.id === r.material_id);
        const step = 10 ** -(m?.decimals || 0);
        return (
          <div className="stock-line" key={r.id}>
            <label>
              Материал
              <select
                required
                value={r.material_id}
                onChange={(e) => change(r.id, 'material_id', e.target.value)}
              >
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Кол-во, {m?.unit}
              <input
                required
                aria-label={'Количество, строка ' + (i + 1)}
                type="number"
                min={step}
                step={step}
                value={r.quantity}
                onChange={(e) => change(r.id, 'quantity', e.target.value)}
              />
            </label>
            {lines.length > 1 && (
              <button
                className="iconbtn"
                type="button"
                aria-label="Удалить строку"
                onClick={() => setLines(lines.filter((v) => v.id !== r.id))}
              >
                <X size={16} />
              </button>
            )}
          </div>
        );
      })}
      {lines.length < materials.length && (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setLines([
              ...lines,
              {
                ...empty(),
                material_id: materials.find((m) => !lines.some((l) => l.material_id === m.id))?.id || '',
              },
            ])
          }
        >
          <Plus size={16} />
          Добавить строку
        </button>
      )}
      <FormFoot
        {...{ busy, error }}
        label={recipe ? 'Сохранить норму' : type === 'purchases' ? 'Провести приход' : 'Провести списание'}
      />
    </form>
  );
}
