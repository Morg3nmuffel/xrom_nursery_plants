import React from 'react';
import { api, careLabels } from './shared';
import { FormFoot, useSubmit } from './components';

export function EmployeeForm({ saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('tasks/employees', { method: 'POST', body: Object.fromEntries(form) });
    saved('Сотрудник добавлен.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Имя сотрудника<input name="name" maxLength={120} required /></label>
    <label>Логин<input name="username" maxLength={120} autoComplete="off" required /></label>
    <label>Пароль<input name="password" type="password" maxLength={1024} autoComplete="new-password" required /></label>
    <FormFoot {...{ busy, error }} label="Добавить сотрудника" />
  </form>;
}

export function TaskForm({ employees, batches, day, saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('tasks/tasks', { method: 'POST', body: {
      title: form.get('title'), instructions: form.get('instructions'), due_on: form.get('due_on'),
      assignee_id: Number(form.get('assignee_id')) || null, batch_id: Number(form.get('batch_id')) || null,
    } });
    saved('Задача добавлена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Название задачи<input name="title" maxLength={200} required /></label>
    <label>Что сделать<textarea name="instructions" maxLength={4000} rows={3} /></label>
    <label>Исполнитель<select name="assignee_id">
      <option value="">Назначить автоматически</option>
      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select></label>
    <label>Партия<select name="batch_id">
      <option value="">Общая задача питомника</option>
      {batches.filter(b => b.quantity > 0).map(b =>
        <option key={b.id} value={b.id}>№{b.id} · {b.name} · {b.location}</option>)}
    </select></label>
    <label>Срок<input name="due_on" type="date" defaultValue={day} required /></label>
    <FormFoot {...{ busy, error }} label="Добавить задачу" />
  </form>;
}

function PriceInput({ value }) {
  return <label>Цена за растение, ₽<input name="price" type="number" min="0" max="9999999999.99"
    step="0.01" defaultValue={value ?? ''} placeholder="Не указана" /></label>;
}

function readPrice(form) {
  const value = form.get('price');
  return value === '' ? null : Number(value);
}

export function PriceForm({ plant, saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    await api('plants/plants/price?id=' + encodeURIComponent(plant.id), {
      method: 'PATCH', body: { price_rub: readPrice(form) },
    });
    saved('Цена сохранена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <strong>{plant.name}</strong><PriceInput value={plant.price_rub} />
    <FormFoot {...{ busy, error }} label="Сохранить цену" />
  </form>;
}

export function CatalogForm({ saved }) {
  const { submit, busy, error } = useSubmit(async form => {
    const care = Object.fromEntries(['scientific_name', 'category', ...Object.keys(careLabels)].map(k => [k, form.get(k)]));
    care.height = { min_cm: Number(form.get('min_cm')), max_cm: Number(form.get('max_cm')) };
    care.hardiness = { zone: form.get('zone'), min_temperature_c: Number(form.get('temperature')), notes: form.get('notes') };
    await api('plants/plants', { method: 'POST', body: { id: form.get('id'), name: form.get('name'), price_rub: readPrice(form), care } });
    saved('Карточка растения сохранена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <label>Название растения<input name="name" maxLength={160} required /></label>
    <label>Артикул<input name="id" maxLength={160} required /></label>
    <PriceInput />
    <label>Научное название<input name="scientific_name" required /></label>
    <label>Категория<input name="category" required /></label>
    {Object.entries(careLabels).map(([key, label]) => <label key={key}>{label}<textarea name={key} rows={2} maxLength={4000} required /></label>)}
    <div className="form-pair">
      <label>Мин. высота, см<input name="min_cm" type="number" min="0" step="any" required /></label>
      <label>Макс. высота, см<input name="max_cm" type="number" min="0" step="any" required /></label>
    </div>
    <div className="form-pair">
      <label>Зона зимостойкости<input name="zone" required /></label>
      <label>Мин. температура, °C<input name="temperature" type="number" step="any" required /></label>
    </div>
    <label>Условия зимовки<textarea name="notes" rows={2} maxLength={4000} /></label>
    <FormFoot {...{ busy, error }} label="Добавить растение" />
  </form>;
}

export function RemoveForm({ target, saved, cancel }) {
  const { submit, busy, error } = useSubmit(async () => {
    await api(target.path, { method: 'DELETE' });
    saved('Запись удалена.');
  });
  return <form className="edit-form" onSubmit={submit}>
    <strong>{target.name}</strong><p>{target.effect}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-foot">
      <button type="button" className="btn" onClick={cancel} disabled={busy}>Отмена</button>
      <button className="btn danger" disabled={busy}>{busy ? 'Удаление…' : 'Удалить'}</button>
    </div>
  </form>;
}
